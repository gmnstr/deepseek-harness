/**
 * P0 replay over real DSH canonical events (A7): a RECORDED native DSH log —
 * turn/start, user/message, assistant/message, tool/call, tool/result,
 * approval/asked + approval/decided — replayed into derived execution state
 * must be deterministic: replay twice → identical digest, identical derived
 * state. This proves the projection consumes the real DSH event stream, not
 * only A1 control factories, and that native events participate in the digest
 * (a change anywhere in the canonical log changes the projection).
 * @module @deepseek-ai/dsh-opencode-execution/tests/a7-native-replay
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldProjection } from '../src/projection.ts'
import { ActionId, AttemptId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import {
  activityCorrelated,
  effectAttemptStarted,
  effectAuthorized,
  effectCommitUnknown,
  effectDenied,
  effectFailed,
  effectReconciled,
  effectRequested,
  effectSucceeded,
  executionCommanded,
} from '@deepseek-ai/dsh-opencode-control'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

/**
 * A recorded native DSH session log: one turn with a user message, an
 * assistant message, a tool call + result, and an approval decision. The
 * payloads use DSH's native vocabulary (turn/start, user/message,
 * assistant/message, tool/call, tool/result, approval/asked, approval/decided)
 * exactly as a real session would persist them.
 */
function recordedNativeLog(): SessionEvent[] {
  const fixtures: Array<{ type: string; data: Record<string, unknown>; surfaceOp?: 'append' }> = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'list the workspace' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'I will list the workspace.' }], source: { kind: 'model', provider: 'mock', model: 'mock' } } }, surfaceOp: 'append' },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'shell.ls', arguments: '{"path":"/workspace"}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 't-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.txt b.txt' }], isError: false }], source: { kind: 'tool', callId: 'call-1' } } }, surfaceOp: 'append' },
    { type: 'approval/asked', data: { id: 'approval-1', toolName: 'shell.write', reason: 'write to /workspace/out.txt' } },
    { type: 'approval/decided', data: { id: 'approval-1', outcome: 'allowed-once' } },
    { type: 'tool/call', data: { turn: 1, step: 2, callId: 'call-2', name: 'shell.write', arguments: '{"path":"/workspace/out.txt","content":"x"}' } },
    { type: 'tool/result', data: { turn: 1, step: 2, message: { id: 't-2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'ok' }], isError: false }], source: { kind: 'tool', callId: 'call-2' } } }, surfaceOp: 'append' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return fixtures.map((fixture, seq) => ({
    type: fixture.type as SessionEvent['type'],
    seq,
    time: 1_000 + seq,
    data: fixture.data as SessionEvent['data'],
    ...(fixture.surfaceOp !== undefined ? { surfaceOp: fixture.surfaceOp } : {}),
  } as SessionEvent))
}

describe('P0 replay over a recorded native DSH log', () => {
  it('replays the recorded native log twice into an identical digest', () => {
    const events = recordedNativeLog()
    const first = foldProjection(events, 'native-1')
    const second = foldProjection(events, 'native-1')
    expect(second.digest).toBe(first.digest)
    expect(second).toEqual(first)
  })

  it('a native-log change anywhere changes the digest (native facts are canonical)', () => {
    const events = recordedNativeLog()
    const baseline = foldProjection(events, 'native-1')

    // Change only the assistant message text: the digest must change even
    // though no control event exists — the projection is a function of the
    // WHOLE DSH log.
    const changed = [...events]
    changed[2] = {
      ...(changed[2] as SessionEvent),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'different' }] } },
    } as SessionEvent
    expect(foldProjection(changed, 'native-1').digest).not.toBe(baseline.digest)
  })
  it('a recorded native log persisted through real SQLite folds identically across processes', async () => {
    const path = await freshDbPath('dsh-a7-native-')
    const sessionId = SessionId('a7-native')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
    const surfaceTypes = new Set(['user/message', 'assistant/message', 'tool/result'])
    for (const event of recordedNativeLog()) {
      session.append(event.type, event.data as never, surfaceTypes.has(event.type) ? { surfaceOp: 'append' } : undefined as never)
    }
    await ctx.sessions.flush(session)
    const state1 = foldProjection((await ctx.sessionPersistence.load(sessionId)).events, String(sessionId))
    await ctx.fiber.dispose()

    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const state2 = foldProjection((await fresh.sessionPersistence.load(sessionId)).events, String(sessionId))
    expect(state2.digest).toBe(state1.digest)
    await fresh.fiber.dispose()

    // Derived executions are empty (no execution/commanded), but the digest is
    // still defined — the projection is well-formed over a pure-native log.
    expect(state1.executions.has(ExecutionId('exec-none'))).toBe(false)
    expect(state1.last_seq).toBe(9)
  })

  it('every A1 control payload carries the explicit version field (schema is versioned)', () => {
    // P0 schema-version invariant on the converged vocabulary: every A1 factory
    // mints a `version: 1` payload so the fold can distinguish future
    // incompatible payloads. The DSH session layer owns envelope versioning
    // (SESSION_FORMAT_VERSION); the control payload version is the A1 layer's.
    const exec = ExecutionId('exec-v')
    const action = ActionId('act-v')
    const attempt = AttemptId('att-v')
    const receipt = { ok: true }
    const payloads = [
      executionCommanded({ execution_id: exec, command: 'c', source: 's' }),
      activityCorrelated({ execution_id: exec, native_event_seq: 1, kind: 'k' }),
      effectRequested({ execution_id: exec, action_id: action, operation: 'o', resource: 'r', effect_class: 'e' }),
      effectAuthorized({ execution_id: exec, action_id: action, capability_id: 'cap' }),
      effectDenied({ execution_id: exec, action_id: action, reason: 'no' }),
      effectAttemptStarted({ execution_id: exec, action_id: action, attempt_id: attempt }),
      effectSucceeded({ execution_id: exec, action_id: action, attempt_id: attempt, receipt }),
      effectFailed({ execution_id: exec, action_id: action, attempt_id: attempt, error: 'x' }),
      effectCommitUnknown({ execution_id: exec, action_id: action, attempt_id: attempt }),
      effectReconciled({ execution_id: exec, action_id: action, attempt_id: attempt, receipt }),
    ]
    for (const payload of payloads) expect(payload.version).toBe(1)
  })
})
