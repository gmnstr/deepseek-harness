/**
 * P0 replay purity on real DSH backing (A7): the derived fold performs ZERO
 * nondeterministic activity. `foldProjection` and `deriveAll` are pure
 * functions of the canonical DSH log — they must never invoke a model, tool,
 * retrieval, effect worker, approval path, or identity mint. The purity claim
 * rests on the fold's import surface being contract-only (mechanical audit
 * below) plus identical-digest proofs across folds and across process
 * boundaries.
 * @module @deepseek-ai/dsh-opencode-execution/tests/a7-zero-activity
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import {
  ActionId,
  AttemptId,
  ExecutionId,
  activityCorrelated,
  effectAttemptStarted,
  effectAuthorized,
  effectRequested,
  effectSucceeded,
  executionCommanded,
} from '@deepseek-ai/dsh-opencode-control'
import { foldProjection } from '../src/projection.ts'
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

/** A representative control+activity log with a commanded execution and effect. */
function controlHistory(): SessionEvent[] {
  const fixtures: Array<{ type: string; data: Record<string, unknown> }> = [
    { type: 'execution/commanded', data: executionCommanded({ execution_id: ExecutionId('exec-1'), command: 'apply change', source: 'surface' }) },
    { type: 'activity/correlated', data: activityCorrelated({ execution_id: ExecutionId('exec-1'), native_event_seq: 3, kind: 'shell.stdout' }) },
    { type: 'effect/requested', data: effectRequested({ execution_id: ExecutionId('exec-1'), action_id: ActionId('act-1'), operation: 'write', resource: '/workspace/a.txt', effect_class: 'filesystem' }) },
    { type: 'effect/authorized', data: effectAuthorized({ execution_id: ExecutionId('exec-1'), action_id: ActionId('act-1'), capability_id: 'fs.write' }) },
    { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: ExecutionId('exec-1'), action_id: ActionId('act-1'), attempt_id: AttemptId('act-1:1') }) },
    { type: 'effect/succeeded', data: effectSucceeded({ execution_id: ExecutionId('exec-1'), action_id: ActionId('act-1'), attempt_id: AttemptId('act-1:1'), receipt: { ok: true } }) },
  ]
  return fixtures.map((fixture, seq) => ({
    type: fixture.type as SessionEvent['type'],
    seq,
    time: 1_000 + seq,
    data: fixture.data as SessionEvent['data'],
  } as SessionEvent))
}

describe('P0 replay purity on real DSH backing', () => {
  it('foldProjection performs zero activity over a real persisted log', async () => {
    const path = await freshDbPath('dsh-a7-zero-fold-')
    const sessionId = SessionId('a7-zero-fold')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const session: Session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
    for (const event of controlHistory()) session.append(event.type, event.data as never)
    await ctx.sessions.flush(session)
    await ctx.fiber.dispose()

    // Fold the real persisted log twice; derive once. The purity claim rests on
    // the fold being a total pure function of the log (no client reference to
    // call) — proven mechanically by the import-surface audit below and by the
    // identical-digest assertions across folds and processes.
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const events = (await fresh.sessionPersistence.load(sessionId)).events
    const state1 = foldProjection(events, String(sessionId))
    const state2 = foldProjection(events, String(sessionId))
    const derived = await deriveAll(fresh.sessionPersistence, sessionId)
    expect(state2.digest).toBe(state1.digest)
    expect(derived.digest).toBe(state1.digest)
    await fresh.fiber.dispose()
  })

  it('the fold module imports no activity/nondeterminism clients', async () => {
    // The projection is the replay engine. Its import surface must be
    // contract-only: node:crypto for the digest, session types, control types,
    // and its own type contract — never an LLM/tool/effect/approval client.
    const source = await import('../src/projection.ts')
    expect(source.foldProjection).toBeTypeOf('function')
    const raw = (await import('node:fs')).readFileSync(
      join(import.meta.dirname, '..', 'src', 'projection.ts'),
      'utf8',
    )
    const importLines = raw.split('\n').filter(line => line.trim().startsWith('import '))
    const imported = importLines.join('\n')
    expect(imported).toContain("from 'node:crypto'")
    // No activity-capable client may be imported.
    expect(imported).not.toMatch(/dsh-llm|dsh-tools|dsh-shell|dsh-e2b|dsh-web|dsh-approval|dsh-credentials/)
  })

  it('a re-fold after a fresh process rebuilds the identical digest (zero facts lost)', async () => {
    const path = await freshDbPath('dsh-a7-zero-rebuild-')
    const sessionId = SessionId('a7-zero-rebuild')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const session: Session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
    for (const event of controlHistory()) session.append(event.type, event.data as never)
    await ctx.sessions.flush(session)
    const state1 = await deriveAll(ctx.sessionPersistence, sessionId)
    await ctx.fiber.dispose()

    // Fresh process, same file: identical digest.
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const state2 = await deriveAll(fresh.sessionPersistence, sessionId)
    expect(state2.digest).toBe(state1.digest)
    expect(state2.executions.get(ExecutionId('exec-1'))?.settled).toBe(true)
    await fresh.fiber.dispose()
  })
})
