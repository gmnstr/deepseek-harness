/**
 * A6 owner-process entry. Spawned with `node --import tsx/esm` by
 * `tests/a6-cross-process-fencing.spec.ts`. Each invocation is one
 * independently-instantiated owner process against the SAME DSH sqlite DB
 * file. Modes:
 *   append <epoch>        — build an ExecutionRuntime with the given writer
 *                           epoch and append one execution/commanded. Prints
 *                           RESULT=APPENDED, RESULT=FENCED:<message>,
 *                           RESULT=SEQ_CONFLICT:<message>, or
 *                           RESULT=ERROR:<message> (exit 1 on ERROR).
 *   migrate <from> <to>   — advanceOwnershipEpoch CAS. Prints RESULT=MIGRATED
 *                           or RESULT=MIGRATE_LOST; RESULT=ERROR:<message>
 *                           (exit 1) on an unexpected failure.
 *   epoch                 — print the stored ownership epoch.
 *
 * Result classification is by real error type/semantic class, never by
 * message sniffing alone: only an actual `SessionOwnershipFencedError` from
 * the SQLite store is FENCED. A sequence/contiguity rejection is
 * SEQ_CONFLICT (a different defect, not fencing). Any other thrown error is
 * ERROR and exits 1 so the spawning test fails rather than mistaking an
 * unrelated failure for fencing evidence.
 *
 * Plain ESM JavaScript (no type annotations): this file is loaded as `.mjs`
 * and tsx does not transpile TypeScript syntax in `.mjs` modules.
 * @module @deepseek-ai/dsh-opencode-execution/tests/fixtures/a6-owner
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, {
  SessionOwnershipFencedError,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import { ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { ExecutionRuntime } from '@deepseek-ai/dsh-opencode-execution'

const [dbPath, sessionIdArg, mode, ...rest] = process.argv.slice(2)
if (!dbPath || !sessionIdArg || !mode) {
  console.error('usage: a6-owner.mjs <dbPath> <sessionId> <append|migrate|epoch> [args...]')
  process.exit(1)
}

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SessionPersistenceSqlite, { path: dbPath, writeBatchMaxDelayMs: 1_000 })
const sessionId = SessionId(sessionIdArg)
const persistence = ctx.sessionPersistence

/** Print a classified failure and exit non-zero so unexpected errors FAIL the caller. */
function failClassification(error, label) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(`${label}:${message}`)
  process.exit(1)
}

// Ensure the session metadata row exists (fenced appends require it). A
// missing row is created here; a second owner reusing the same DB must not
// fail on an existing row.
try {
  await persistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
} catch (error) {
  // A second owner reusing the same DB legitimately sees an existing session
  // (metadata row or persisted log); those are not errors.
  if (!(error instanceof Error)) throw error
  if (!/already exists|already has a persisted log/.test(error.message)) throw error
}

if (mode === 'epoch') {
  try {
    const epoch = await persistence.ownershipEpochOf(sessionId)
    console.log(`EPOCH=${epoch === undefined ? 'undefined' : epoch}`)
    await ctx.fiber.dispose()
    process.exit(0)
  } catch (error) {
    failClassification(error, 'EPOCH_ERROR')
  }
}

if (mode === 'migrate') {
  const from = Number(rest[0])
  const to = Number(rest[1])
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    console.error('migrate requires <from> <to> integers')
    process.exit(1)
  }
  try {
    const ok = await persistence.advanceOwnershipEpoch(sessionId, from, to)
    console.log(ok ? 'RESULT=MIGRATED' : 'RESULT=MIGRATE_LOST')
    await ctx.fiber.dispose()
    process.exit(0)
  } catch (error) {
    failClassification(error, 'RESULT=ERROR')
  }
}

if (mode === 'append') {
  const epoch = Number(rest[0])
  if (!Number.isSafeInteger(epoch)) {
    console.error('append requires an epoch integer')
    process.exit(1)
  }
  const runtime = new ExecutionRuntime({
    persistence,
    session_id: sessionId,
    writer: { worker_id: `a6-owner-${process.pid}-e${epoch}`, ownership_epoch: epoch },
  })
  try {
    await runtime.beginExecution(ExecutionId(`exec-${process.pid}-${epoch}`), 'append', 'surface')
    console.log('RESULT=APPENDED')
  } catch (error) {
    if (error instanceof SessionOwnershipFencedError) {
      // The ONLY legitimate fencing evidence: the durable epoch rejected the
      // writer's stale token. Classified by the real error type, not the
      // message text.
      console.log(`RESULT=FENCED:${error.message}`)
    } else if (error instanceof Error && /append starts at seq|stored next seq|seq mismatch/.test(error.message)) {
      // A sequence/contiguity rejection is a different defect than fencing
      // (e.g. a lost race re-derives a stale cursor). It must not be reported
      // as FENCED.
      console.log(`RESULT=SEQ_CONFLICT:${error.message}`)
    } else {
      failClassification(error, 'RESULT=ERROR')
    }
  }
  await ctx.fiber.dispose()
  process.exit(0)
}

console.error(`unknown mode ${mode}`)
process.exit(1)
