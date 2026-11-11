/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto'

// A small in-memory stand-in for the Prisma client, for tests that need the real services to run against
// state instead of canned answers. It implements exactly what the adjustment and correction services call:
// findMany / findFirst / findUnique / count / create / createMany / update / updateMany / delete / deleteMany,
// `where` (equality, null, Date, not / in / notIn / lt / lte / gt / gte, OR / AND / NOT, a to-one relation
// filter), `select`, `include` (to-one relations), `orderBy` and `take`.
//
// A transaction snapshots every table first and puts the snapshot back when the callback throws, so a test can
// prove that a failure in the middle of a transaction leaves nothing written. `log` records every write
// ("payrollAdjustment.update") and anything a test pushes into it (the mocked week lock pushes "lock"), so
// order can be asserted. `failOn` makes the matching write throw.
//
// It is not a database: no constraints, no unique keys, no Decimal (numbers are stored as numbers, and the
// services read them through Number()).

type Row = Record<string, any>
type Args = Record<string, any>

interface Relation {
  table: string
  local: string
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  payrollAdjustmentApplication: {
    payrollAdjustment: { table: 'payrollAdjustment', local: 'payrollAdjustmentId' },
    employee: { table: 'employee', local: 'employeeId' },
    payrollRun: { table: 'payrollRun', local: 'payrollRunId' },
    payrollRevision: { table: 'payrollRevision', local: 'payrollRevisionId' },
  },
  payrollCorrectionSession: {
    payrollRun: { table: 'payrollRun', local: 'payrollRunId' },
    attendanceUpload: { table: 'attendanceUpload', local: 'attendanceUploadId' },
  },
  payrollRunEmployee: {
    payrollRevision: { table: 'payrollRevision', local: 'payrollRevisionId' },
    payrollRun: { table: 'payrollRun', local: 'payrollRunId' },
  },
  payrollRevision: {
    payrollRun: { table: 'payrollRun', local: 'payrollRunId' },
  },
  attendancePunch: {
    employee: { table: 'employee', local: 'employeeId' },
  },
}

const DEFAULTS: Record<string, () => Row> = {
  payrollAdjustment: () => ({ skippedCarryForwardCount: 0, createdAt: new Date() }),
  payrollAdjustmentApplication: () => ({
    payrollRunId: null,
    payrollRevisionId: null,
    approvedBy: null,
    approvedAt: null,
    appliedAt: null,
    skippedAt: null,
    carriedForwardToPayrollWeekStartDate: null,
    isReversed: false,
  }),
  payrollCorrectionSession: () => ({
    correctionReason: null,
    correctionTypesJson: [],
    adjustmentSnapshotJson: null,
    draftRevisionId: null,
    createdAt: new Date(),
    appliedAt: null,
    abandonedAt: null,
  }),
  payrollRevision: () => ({ isCurrent: false, approvedAt: null, correctionReason: null }),
  attendancePunch: () => ({ correctionId: null, clonedFromPunchId: null, employeeId: null, note: null }),
}

const clone = <T>(value: T): T => structuredClone(value)

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  if (a == null || b == null) return a == null && b == null
  return a === b
}

function isOperatorObject(cond: unknown): cond is Args {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date || Array.isArray(cond)) return false
  const keys = Object.keys(cond as object)
  return keys.length > 0 && keys.every((k) => ['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte'].includes(k))
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number)
  const y = b instanceof Date ? b.getTime() : (b as number)
  return x < y ? -1 : x > y ? 1 : 0
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (isOperatorObject(cond)) {
    return Object.entries(cond).every(([op, expected]) => {
      switch (op) {
        case 'equals':
          return sameValue(actual, expected)
        case 'not':
          return !sameValue(actual, expected)
        case 'in':
          return (expected as unknown[]).some((v) => sameValue(actual, v))
        case 'notIn':
          return !(expected as unknown[]).some((v) => sameValue(actual, v))
        case 'lt':
          return actual != null && compare(actual, expected) < 0
        case 'lte':
          return actual != null && compare(actual, expected) <= 0
        case 'gt':
          return actual != null && compare(actual, expected) > 0
        case 'gte':
          return actual != null && compare(actual, expected) >= 0
        default:
          throw new Error(`memory-db: unsupported operator ${op}`)
      }
    })
  }
  return sameValue(actual, cond)
}

export interface MemoryFault {
  op: string
  error: Error
  /** How many matching writes to let through before throwing. */
  skip: number
}

export interface MemoryDb {
  [table: string]: any
  /** Every write, as "table.method", plus whatever a test pushes. */
  log: string[]
  faults: MemoryFault[]
  seed(table: string, rows: Row[]): void
  rows(table: string): Row[]
  snapshot(): Record<string, Row[]>
  restore(snapshot: Record<string, Row[]>): void
  /** Make the nth (0-based) write matching `op` ("payrollAdjustment.update") throw `error`. */
  failOn(op: string, error?: Error, skip?: number): void
  reset(): void
}

class Table {
  rows: Row[] = []

  constructor(
    private readonly name: string,
    private readonly db: DbCore,
  ) {}

  private matches(row: Row, where: Args | undefined): boolean {
    if (!where) return true
    return Object.entries(where).every(([key, cond]) => {
      if (cond === undefined) return true
      if (key === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w: Args) => this.matches(row, w))
      if (key === 'OR') return (cond as Args[]).some((w) => this.matches(row, w))
      if (key === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w: Args) => this.matches(row, w))
      const relation = RELATIONS[this.name]?.[key]
      if (relation) {
        const related = this.db.table(relation.table).rows.find((r) => r.id === row[relation.local])
        return related !== undefined && this.db.table(relation.table).matches(related, cond as Args)
      }
      return matchValue(row[key], cond)
    })
  }

  private shape(row: Row, args: Args): Row {
    const out: Row = args.select
      ? Object.fromEntries(Object.entries(args.select).filter(([, on]) => on === true).map(([k]) => [k, clone(row[k])]))
      : clone(row)
    const relations = { ...(args.include ?? {}), ...Object.fromEntries(Object.entries(args.select ?? {}).filter(([, on]) => typeof on === 'object')) }
    for (const [key, spec] of Object.entries(relations)) {
      const relation = RELATIONS[this.name]?.[key]
      if (!relation || !spec) continue
      const related = this.db.table(relation.table).rows.find((r) => r.id === row[relation.local])
      out[key] = related ? this.db.table(relation.table).shape(related, spec === true ? {} : (spec as Args)) : null
    }
    return out
  }

  private write(method: string): void {
    const op = `${this.name}.${method}`
    this.db.log.push(op)
    const index = this.db.faults.findIndex((f) => f.op === op)
    if (index === -1) return
    const fault = this.db.faults[index]
    if (fault.skip > 0) {
      fault.skip -= 1
      return
    }
    this.db.faults.splice(index, 1)
    throw fault.error
  }

  private select(args: Args = {}): Row[] {
    let found = this.rows.filter((row) => this.matches(row, args.where))
    if (args.orderBy) {
      const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]
      found = [...found].sort((a, b) => {
        for (const order of orders) {
          const [field, dir] = Object.entries(order)[0] as [string, 'asc' | 'desc']
          const c = compare(a[field], b[field])
          if (c !== 0) return dir === 'desc' ? -c : c
        }
        return 0
      })
    }
    if (args.take !== undefined) found = found.slice(0, args.take)
    return found
  }

  async findMany(args: Args = {}) {
    return this.select(args).map((row) => this.shape(row, args))
  }

  async findFirst(args: Args = {}) {
    const row = this.select(args)[0]
    return row ? this.shape(row, args) : null
  }

  async findUnique(args: Args = {}) {
    return this.findFirst(args)
  }

  async findUniqueOrThrow(args: Args = {}) {
    const found = await this.findFirst(args)
    if (!found) throw new Error(`memory-db: no ${this.name} row for ${JSON.stringify(args.where)}`)
    return found
  }

  async count(args: Args = {}) {
    return this.select(args).length
  }

  async create({ data }: Args) {
    this.write('create')
    const row = { id: randomUUID(), ...DEFAULTS[this.name]?.(), ...clone(data) }
    this.rows.push(row)
    return clone(row)
  }

  async createMany({ data }: Args) {
    this.write('createMany')
    for (const item of data as Row[]) this.rows.push({ id: randomUUID(), ...DEFAULTS[this.name]?.(), ...clone(item) })
    return { count: (data as Row[]).length }
  }

  async update({ where, data }: Args) {
    this.write('update')
    const row = this.select({ where })[0]
    if (!row) throw new Error(`memory-db: no ${this.name} row to update for ${JSON.stringify(where)}`)
    Object.assign(row, clone(data))
    return clone(row)
  }

  async updateMany({ where, data }: Args) {
    this.write('updateMany')
    const found = this.select({ where })
    for (const row of found) Object.assign(row, clone(data))
    return { count: found.length }
  }

  async delete({ where }: Args) {
    this.write('delete')
    const row = this.select({ where })[0]
    if (!row) throw new Error(`memory-db: no ${this.name} row to delete for ${JSON.stringify(where)}`)
    this.rows = this.rows.filter((r) => r !== row)
    return clone(row)
  }

  async deleteMany({ where }: Args = {}) {
    this.write('deleteMany')
    const found = new Set(this.select({ where }))
    this.rows = this.rows.filter((r) => !found.has(r))
    return { count: found.size }
  }
}

interface DbCore {
  log: string[]
  faults: MemoryFault[]
  table(name: string): Table
}

export function createMemoryDb(): MemoryDb {
  const tables = new Map<string, Table>()
  const core: DbCore = {
    log: [],
    faults: [],
    table(name: string) {
      let table = tables.get(name)
      if (!table) {
        table = new Table(name, core)
        tables.set(name, table)
      }
      return table
    },
  }

  const api = {
    get log() {
      return core.log
    },
    get faults() {
      return core.faults
    },
    seed(table: string, rows: Row[]) {
      const t = core.table(table)
      for (const row of rows) t.rows.push({ id: randomUUID(), ...DEFAULTS[table]?.(), ...clone(row) })
    },
    rows(table: string) {
      return core.table(table).rows.map(clone)
    },
    snapshot() {
      return Object.fromEntries([...tables.entries()].map(([name, t]) => [name, clone(t.rows)]))
    },
    restore(snapshot: Record<string, Row[]>) {
      for (const [name, t] of tables) t.rows = clone(snapshot[name] ?? [])
    },
    failOn(op: string, error: Error = new Error(`memory-db: ${op} failed`), skip = 0) {
      core.faults.push({ op, error, skip })
    },
    reset() {
      for (const t of tables.values()) t.rows = []
      core.log.length = 0
      core.faults.length = 0
    },
    async $transaction(arg: unknown) {
      if (typeof arg === 'function') {
        const before = api.snapshot()
        try {
          return await (arg as (tx: unknown) => Promise<unknown>)(proxy)
        } catch (error) {
          api.restore(before)
          throw error
        }
      }
      return Promise.all(arg as Promise<unknown>[])
    },
  }

  const proxy: MemoryDb = new Proxy(api as unknown as MemoryDb, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target || prop.startsWith('$') || prop === 'then') return Reflect.get(target, prop)
      return core.table(prop)
    },
  })
  return proxy
}
