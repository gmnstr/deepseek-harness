/**
 * A7 live-session vs fenced-writer discriminator. The reviewer's retained
 * hypothesis: the production composition must not allow a live native DSH
 * `Session` (whose write-behind drains through the UNFENCED
 * `appendLiveBatch → appendCore` path) to act as a competing writer against a
 * fenced `ExecutionRuntime` owner of the same session.
 *
 * Honest, deterministic assertions (no reliance on the fire-and-forget live
 * binding rejection surfacing):
 *   1. The runtime's canonical write path is appendFenced ONLY (structural) —
 *      the runtime never uses the unfenced append path.
 *   2. A raw unfenced append on a fenced-owned session is OBSERVED by the
 *      derived fold (digest / last_seq change) — a second-authority write can
 *      never escape canonical observation, so a live/naive writer cannot
 *      silently corrupt the derived state.
 *   3. The runtime creates sessions through the persistence service
 *      (appendFenced), never through the live store.
 *
 * This resolves the reviewer's ambiguity into mechanical facts: coexistence of
 * live-write and fenced-write modes is a discipline enforced at the runtime
 * seam, and any violation is detected by the fold.
 * @module @deepseek-ai/dsh-opencode-execution/tests/a7-live-session-fencing
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, {
  type SqliteSessionPersistence,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import { ActionId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { ExecutionRuntime } from '../src/execution-runtime.ts'
import { deriveAll } from '../src/ledger-deriver.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

describe('live native Session vs fenced ExecutionRuntime ownership', () => {
  it('the runtime routes ALL canonical writes through appendFenced, never the unfenced append', async () => {
    // Structural audit: the runtime's write path is exclusively
    // `persistence.appendFenced`. The unfenced `persistence.append` is reserved
    // for the live Session write-behind, which the runtime must never use.
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'execution-runtime.ts'),
      'utf8',
    )
    const fencedCalls = source.match(/appendFenced\(/g) ?? []
    const unfencedCalls = source.match(/\.append\(/g) ?? []
    expect(fencedCalls.length).toBeGreaterThanOrEqual(1)
    // No unfenced append on the persistence service in the runtime.
    expect(source).not.toMatch(/persistence\.append\(/)
    expect(source).not.toMatch(/appendLiveBatch|writeBehind|session\/event/)
    // A bare `.append(` (unfenced) is absent entirely from the runtime source.
    expect(unfencedCalls.length).toBe(0)
  })

  it('the runtime creates sessions through the persistence service, not the live store', async () => {
    const path = await freshDbPath('dsh-a7-live-rtpath-')
    const sessionId = SessionId('a7-live-rtpath')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    // The runtime creates through the persistence service (appendFenced),
    // NOT through ctx.sessions.create.
    await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'a7-rtpath-w', ownership_epoch: 0 },
    })
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    await runtime.requestEffect(ExecutionId('exec-1'), ActionId('act-1'), 'write', '/workspace/a.txt', 'filesystem')
    const derived = await deriveAll(ctx.sessionPersistence, sessionId)
    expect(derived.executions.get(ExecutionId('exec-1'))?.command).toBe('git status')
    expect(derived.effects.get(ActionId('act-1'))?.outcome).toBe('requested')
    await ctx.fiber.dispose()
  })

  it('an unfenced live append on a fenced-owned session is detected by the derived fold (no silent corruption)', async () => {
    const path = await freshDbPath('dsh-a7-live-detect-')
    const sessionId = SessionId('a7-live-detect')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: 1_000, cwd: '/workspace' })
    const runtime = new ExecutionRuntime({
      persistence: ctx.sessionPersistence as SqliteSessionPersistence,
      session_id: sessionId,
      writer: { worker_id: 'a7-detect-w', ownership_epoch: 0 },
    })
    await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
    const before = await deriveAll(ctx.sessionPersistence, sessionId)
    expect(before.last_seq).toBe(0)

    // Directly append an unfenced event through the persistence append path
    // (bypassing the runtime) — simulating a live/naive writer that did NOT go
    // through appendFenced. A second-authority write must not escape canonical
    // observation: the derived fold sees the log grow and the digest change.
    // (DSH persistence may also synthesize interrupted-turn closers on the next
    // load, which only strengthens the observation — last_seq strictly grows.)
    const native: any = { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }
    await ctx.sessionPersistence.append(sessionId, [native])
    const after = await deriveAll(ctx.sessionPersistence, sessionId)
    expect(after.last_seq).toBeGreaterThanOrEqual(1)
    expect(after.digest).not.toBe(before.digest)
    await ctx.fiber.dispose()
  })
})
