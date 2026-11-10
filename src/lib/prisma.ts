import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? ''

const pool = new Pool({
  connectionString,
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  // Supabase's pooler certificate chains to Supabase's own CA, which Node does not trust by default, so
  // chain verification is off (same as scripts/backfill-*.js). The link is still encrypted. To verify, ship the
  // CA from the Supabase dashboard and use { ca, rejectUnauthorized: true } here and in those scripts together.
  ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : undefined,
})

const adapter = new PrismaPg(pool)

const prismaClientSingleton = () => {
  return new PrismaClient({ adapter })
}

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma
