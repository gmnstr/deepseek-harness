/**
 * A6 owner-process entry. Spawned with `node --import tsx/esm` by
 * `tests/a6-cross-process-fencing.spec.ts`. Each invocation is one
 * independently-instantiated owner process against the SAME DSH sqlite DB
 * file. Modes:
 *   append <epoch>        — build an ExecutionRuntime with the given writer
 *                           epoch and append one execution/commanded. Prints
 *                           APPENDED or FENCED:<message>.
 *   migrate <from> <to>   — advanceOwnershipEpoch CAS. Prints MIGRATED or
 *                           MIGRATE_LOST.
 *   epoch                 — print the stored ownership epoch.
 * @module @deepseek-ai/dsh-opencode-execution/tests/fixtures/a6-owner
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
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
  const epoch = await persistence.ownershipEpochOf(sessionId)
  console.log(`EPOCH=${epoch === undefined ? 'undefined' : epoch}`)
  await ctx.fiber.dispose()
  process.exit(0)
}

if (mode === 'migrate') {
  const from = Number(rest[0])
  const to = Number(rest[1])
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    console.error('migrate requires <from> <to> integers')
    process.exit(1)
  }
  const ok = await persistence.advanceOwnershipEpoch(sessionId, from, to)
  console.log(ok ? 'RESULT=MIGRATED' : 'RESULT=MIGRATE_LOST')
  await ctx.fiber.dispose()
  process.exit(0)
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
    const message = error instanceof Error ? error.message : String(error)
    console.log(`RESULT=FENCED:${message}`)
  }
  await ctx.fiber.dispose()
  process.exit(0)
}

console.error(`unknown mode ${mode}`)
process.exit(1)
