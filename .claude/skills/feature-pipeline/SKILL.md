---
name: feature-pipeline
description: Run a feature through a planner→coder→tester→reviewer pipeline coordinated by ruflo — swarm topology, a shared-memory handoff bus, per-role model routing, and cross-session learning. You stay the final gate; nothing merges.
disable-model-invocation: false
---

# Feature Pipeline (ruflo)

Four specialists implement one feature in sequence, each in its own clean context.
**ruflo coordinates; native `Agent` subagents execute; you are the final gate.**

> The stages run **sequentially on purpose** — a handoff chain with a stop-gate
> between each. This is *not* the place for ruflo's "spawn all agents in one
> message" parallel rule; that's for independent agents. Don't collapse these
> stages into a concurrent spawn.

- **ruflo = coordination spine.** Swarm topology, the **handoff** bus (a persistent
  memory namespace), model routing, and learning hooks.
- **Native `Agent` subagents = execution.** Each role runs in an isolated context with
  real tools — because ruflo's `agent_execute` is a one-shot Messages-API call and
  cannot edit the repo.
- **The handoff bus** is the ruflo memory namespace `feature/<slug>`, with keys
  `spec`, `changes`, `test-results`, `review`. Each role reads the prior handoff and
  writes its own. A new feature gets a new namespace, so handoffs are never stale.
- **You are the final gate.** The pipeline reports a verdict and stops. It never merges.

## Role routing

| Role     | Model  | Tools                  | Reads handoff        | Writes handoff |
|----------|--------|------------------------|----------------------|----------------|
| planner  | opus  | read-only              | —                    | `spec`         |
| coder    | sonnet | Read/Write/Edit/Bash   | `spec`               | `changes`      |
| tester   | sonnet | Read/Write/Edit/Bash   | `spec`, `changes`    | `test-results` |
| reviewer | opus   | read-only + Bash¹      | all of the above     | `review`       |

Fable up front, where planning sets the ceiling for everything downstream; Opus at the
end, where review is the last catch; Sonnet through the bulk middle (implementation
against a clear spec).

¹ The reviewer gets Bash **for inspection only** — `git` and `ocr` reads. No Write, no
Edit, no `git` command that mutates. See Hard rules.

## Steps

**0 — Init the swarm and the bus.**
- Derive a kebab `<slug>` from the feature request.
- `mcp__ruflo__swarm_init` `{ topology: "hierarchical", maxAgents: 5, strategy: "specialized" }`.
- `mcp__ruflo__hooks_pre-task` `{ taskId: "<slug>", description: <feature request> }`,
  so ruflo's router and learning engine engage from the start — it returns suggested
  agents and recalls prior patterns. Reuse `<slug>` as the `taskId` here and in Step 5
  so the run's start and outcome correlate for learning.
- If the project tracks work issue-first (check its CLAUDE.md), file or locate the
  tracking issue now and put its number in the `spec` handoff.
- ✅ Done when: a swarm id is returned and `<slug>` is fixed.

**1 — Plan.** `mcp__ruflo__agent_spawn` `{ agentType: "planner", model: "fable" }`, then
run a read-only planner subagent. It reads the relevant code and produces a spec: files
to create/modify (exact paths), interfaces/signatures, edge cases, and which existing
pattern to copy (name the file). It also flags whether the feature introduces **new UI**
(new components, pages, or screens), so the Code stage routes that build to
`/impeccable craft`. Anything ambiguous is an `OPEN QUESTION` at the top.
Persist its output to `feature/<slug>:spec` via `mcp__ruflo__memory_store`.
- ✅ Done when: `spec` is stored with all four sections **and zero unresolved
  OPEN QUESTIONS**. If any remain, **stop and surface them to me** — do not guess.

**2 — Code.** `mcp__ruflo__agent_spawn` `{ agentType: "coder", model: "sonnet" }`, then
run a coder subagent with the spec in its prompt. It implements exactly the spec,
follows the named patterns, adds nothing extra, and refactors no unrelated code.
Persist its summary to `feature/<slug>:changes`.

> **New UI is built with `/impeccable`, not hand-rolled.** When the spec flags new
> UI (new components, pages, or screens — or a redesign of one), build that surface by
> running `/impeccable <feature>` instead of having the coder hand-write markup and
> styles. That flow owns the production-grade UI — design system, every state, responsive,
> a11y, and in-browser verification — and is the project's standard for any new interface.
> The coder then wires the result in and records it in `changes`; back-end and non-visual
> logic are still implemented directly in this stage.

- ✅ Done when: every file named in the spec is created/modified (any new UI built via
  `/impeccable craft`), and `changes` lists each touched file with what changed and where
  the tester should focus.

**3 — Test.** `mcp__ruflo__agent_spawn` `{ agentType: "tester", model: "sonnet" }`, then
run a tester subagent with `spec` + `changes` in its prompt. It writes tests for the
happy path, every spec-named edge case, and at least one failure case in the repo's
existing framework, then **runs** them. Persist results to `feature/<slug>:test-results`.
- ✅ Done when: the test command actually ran and `test-results` records pass/fail per
  case. **If any test fails, stop and show me the failures.** The tester never patches
  code to make a test pass — a red suite halts the pipeline.

**4 — Review.** Two passes that see different things, reconciled into one verdict.
They are complementary on purpose: 4a asks *"did this violate a house rule?"* and 4b asks
*"is this wrong?"*. Neither subsumes the other — a generic reviewer re-derives what matters
every run and forgets this repo's invariants, which is exactly what `.opencodereview/rule.json`
pins deterministically.

**4a — House rules (OCR delegation).** `mcp__ruflo__agent_spawn`
`{ agentType: "reviewer", model: "opus" }`, then run a **read-only** reviewer subagent with
Bash-for-inspection. It reads `spec`/`changes`/`test-results`, then drives the `ocr` CLI
directly:

```bash
ocr delegate preview --from main --to <branch>     # range mode; note the merge_base it prints
ocr delegate rule <path1> <path2> ...              # rules grouped by content
git diff <merge_base>..<branch> -- <path>          # per-file diff
```

Review each file against **its resolved rule group**, not a generic checklist — the group
is the checklist. Classify `critical | high | medium | low`. Persist findings to
`feature/<slug>:review-houserules`.

> **Drive the CLI, never the `/open-code-review:delegate-review` slash command.** That
> command's shipped prompt ends with *"Automatically fix High and Medium issues"* — it
> would hand the reviewer a fix mandate and collapse the read-only separation. The CLI
> sub-commands are pure output.

- If `ocr` is missing: `npm i -g @alibaba-group/open-code-review`. No LLM config is needed
  or wanted — delegation mode never calls an LLM; this subagent *is* the model.
- ✅ Done when: `review-houserules` lists every reviewable file with findings or an
  explicit "no findings", and names the rule group each was judged against.

**4b — General defects (`/code-review`).** Run at **orchestrator level, not in a subagent** —
`/code-review` is built into Claude Code with no command file to hand a subagent. Report-only:
do **not** let it apply fixes; the human gate decides. Persist its findings to
`feature/<slug>:review-defects`.
- If it can't be invoked in-session, **stop and ask me to run it**, then resume with the
  output. Do not silently skip the pass and do not substitute an ad-hoc review for it.
- ✅ Done when: `review-defects` holds the findings, or I have explicitly waived the pass.

**4c — Reconcile.** Merge both passes into one verdict. Same file+line from both passes is
**one** finding — keep the more specific rationale. A house-rule violation is never
downgraded to a nit: `scripts/assert-no-prisma-in-client.mjs` and the DoD are gates, so
those findings are High or above. Persist to `feature/<slug>:review`.
- ✅ Done when: `review` carries exactly one line —
  `VERDICT: SHIP | NEEDS WORK | BLOCK` — with specifics for anything but SHIP, and both
  passes are accounted for (findings or a stated waiver).

**5 — Report and gate.**
- Show me `review` and the one-line verdict. Summarize what each stage left in the bus.
- `mcp__ruflo__hooks_post-task` `{ taskId: "<slug>", success, quality }` (same `<slug>`
  as Step 0) so ruflo records the run's outcome for cross-session learning.
- **Do not merge.** Leave the branch for my review.
- ✅ Done when: the verdict is in front of me and the branch is untouched by a merge.

## Hard rules

These three constraints are what make the separation real — keep them inviolable.

- **The tester never fixes code.** If it both implemented and tested, the separation
  collapses. Red tests stop the pipeline; I decide what happens next.
- **The reviewer is read-only.** A model that can patch what it judges rationalizes
  instead of flagging. Stripping its write tools is what makes the review honest. It holds
  Bash only to *read* — `ocr delegate`, `ocr rules check`, `git diff`/`show`/`log`. No Write,
  no Edit, no mutating `git`, and never a review prompt carrying a fix mandate (this is why
  4a drives the `ocr` CLI instead of the auto-fixing slash command).
- **Never merge.** Green tests are not the same as correct behavior. The human gate is
  the point of the whole pipeline.
