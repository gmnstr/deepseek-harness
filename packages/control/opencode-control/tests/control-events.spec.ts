import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import {
  ActionId,
  activityCorrelated,
  AttemptId,
  effectAttemptStarted,
  effectAuthorized,
  effectCommitUnknown,
  effectDenied,
  effectFailed,
  effectReconciled,
  effectRequested,
  effectSucceeded,
  ExecutionId,
  executionCommanded,
  type DshControlPayload,
} from '@deepseek-ai/dsh-opencode-control'

/**
 * Every control event this package declares, in catalog order. The spec
 * iterates this list so vocabulary and persistence assertions cannot drift
 * from the merge.
 */
const CONTROL_EVENT_TYPES = [
  'execution/commanded',
  'activity/correlated',
  'effect/requested',
  'effect/authorized',
  'effect/denied',
  'effect/attempt-started',
  'effect/succeeded',
  'effect/failed',
  'effect/commit-unknown',
  'effect/reconciled',
] as const

/** Fixed ids for the fixture log; every payload references the same execution. */
const EXECUTION = ExecutionId('exec-1')
const ACTION = ActionId('act-1')
const ATTEMPT = AttemptId('attempt-1')

/**
 * The durable payload of every control event over the fixed fixture ids, in
 * declaration order. Each factory result type-checks as the exact
 * `SessionEventMap[type]` data of the corresponding event.
 */
function controlPayloads(): Array<DshControlPayload<(typeof CONTROL_EVENT_TYPES)[number]>> {
  return [
    executionCommanded({ execution_id: EXECUTION, command: 'git status', source: 'surface' }),
    activityCorrelated({ execution_id: EXECUTION, native_event_seq: 1, kind: 'shell.stdout' }),
    effectRequested({
      execution_id: EXECUTION,
      action_id: ACTION,
      operation: 'write',
      resource: '/workspace/notes.md',
      effect_class: 'filesystem',
    }),
    effectAuthorized({ execution_id: EXECUTION, action_id: ACTION, capability_id: 'fs.write' }),
    effectDenied({ execution_id: EXECUTION, action_id: ACTION, reason: 'sandbox denies writes outside /workspace' }),
    effectAttemptStarted({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT }),
    effectSucceeded({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT, receipt: { ok: true } }),
    effectFailed({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT, error: 'EACCES' }),
    effectCommitUnknown({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT }),
    effectReconciled({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT, receipt: { ok: true } }),
  ]
}

/**
 * One turn that interleaves the native surface vocabulary (turn/user/step/
 * assistant/tool-call/tool-result/approval/turn-end) with every control event
 * at the requested positions. Returns `{ type, data }` pairs WITHOUT seq/time
 * so the fixture stays readable; the caller assigns seqs at append time.
 */
function interleavedControlEvents(): Array<{ type: string; data: Record<string, unknown> }> {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'run the audit' }], source: { kind: 'user' } } },
    { type: 'execution/commanded', data: executionCommanded({ execution_id: EXECUTION, command: 'git status', source: 'surface' }) },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'checking' }], source: { kind: 'model', provider: 'mock', model: 'mock' } } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"git status"}' } },
    { type: 'activity/correlated', data: activityCorrelated({ execution_id: EXECUTION, native_event_seq: 1, kind: 'shell.stdout' }) },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 't-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'clean' }], isError: false }], source: { kind: 'tool', callId: 'call-1' } } } },
    { type: 'approval/asked', data: { id: 'ap-1', toolName: 'fs' } },
    { type: 'effect/requested', data: effectRequested({ execution_id: EXECUTION, action_id: ACTION, operation: 'write', resource: '/workspace/notes.md', effect_class: 'filesystem' }) },
    { type: 'approval/decided', data: { id: 'ap-1', outcome: 'allowed-once' } },
    { type: 'effect/authorized', data: effectAuthorized({ execution_id: EXECUTION, action_id: ACTION, capability_id: 'fs.write' }) },
    { type: 'effect/denied', data: effectDenied({ execution_id: EXECUTION, action_id: ACTION, reason: 'sandbox denies writes outside /workspace' }) },
    { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT }) },
    { type: 'effect/succeeded', data: effectSucceeded({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT, receipt: { ok: true } }) },
    { type: 'effect/failed', data: effectFailed({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT, error: 'EACCES' }) },
    { type: 'effect/commit-unknown', data: effectCommitUnknown({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT }) },
    { type: 'effect/reconciled', data: effectReconciled({ execution_id: EXECUTION, action_id: ACTION, attempt_id: ATTEMPT, receipt: { ok: true } }) },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** The three message-producing surface event types; their appends carry surfaceOp. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Append a readable fixture to a session, assigning contiguous seqs and time. */
function appendFixture(session: Session, events: Array<{ type: string; data: Record<string, unknown> }>): SessionEvent[] {
  return events.map((event, seq) => {
    const appended = SURFACE_TYPES.has(event.type)
      ? session.append(event.type as SessionEventType, event.data as SessionEventMap[SessionEventType], { surfaceOp: 'append' })
      : session.append(event.type as SessionEventType, event.data as SessionEventMap[SessionEventType])
    return { ...appended, seq, time: 1_000 + seq }
  })
}

async function freshDbDir(prefix: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, path: join(dir, 'sessions.db') }
}

describe('opencode-control event vocabulary', () => {
  it('declares all 10 control events in the merge-extensible SessionEventMap', () => {
    // Proof 1 (declaration merge): every control type satisfies
    // `keyof SessionEventMap` — a compile-time assertion that fails if the
    // merge is not visible to this program.
    for (const type of CONTROL_EVENT_TYPES) {
      expect(type satisfies SessionEventType).toBe(type)
    }
    expect(CONTROL_EVENT_TYPES).toHaveLength(10)
  })

  it('registers every control event in the generated KNOWN_SESSION_EVENT_TYPES', () => {
    // Proof 2 (known vocabulary): the regenerated runtime set contains all 10.
    for (const type of CONTROL_EVENT_TYPES) {
      expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    }
  })

  it('brands ids and builds versioned payloads with the exported factories', () => {
    const payload = executionCommanded({ execution_id: EXECUTION, command: 'git status', source: 'surface' })
    expect(payload).toEqual({ version: 1, execution_id: 'exec-1', command: 'git status', source: 'surface' })
    expect(EXECUTION).toBe('exec-1')
    expect(ACTION).toBe('act-1')
    expect(ATTEMPT).toBe('attempt-1')
    // Every payload pins its version at 1.
    for (const payload of controlPayloads()) {
      expect(payload).toMatchObject({ version: 1 })
    }
  })
})

describe('opencode-control real Session append', () => {
  it('accepts every control event through Session.append with contiguous seqs', () => {
    // Proof 3: a real (detached) Session accepts the merged vocabulary and
    // assigns contiguous sequence numbers, interleaved with native events.
    const session = Session.create(SessionId('control-append'))
    const firstSeq = session.seq
    const appended = appendFixture(session, interleavedControlEvents())
    expect(session.events.length).toBe(firstSeq + appended.length)
    expect(session.events.map(e => e.seq)).toEqual(
      Array.from({ length: appended.length }, (_, i) => firstSeq + i),
    )
    const types = session.events.map(e => e.type)
    for (const type of CONTROL_EVENT_TYPES) {
      expect(types).toContain(type)
    }
  })

  it('keeps control events out of the derived model-visible transcript', () => {
    // Proof 6: deriveMessages() folds the surface, and none of the control
    // events are surface-eligible, so the transcript contains only the native
    // user/assistant/tool messages.
    const session = Session.create(SessionId('control-surface'))
    appendFixture(session, interleavedControlEvents())
    const messages = session.deriveMessages()
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    const transcript = JSON.stringify(messages)
    for (const type of CONTROL_EVENT_TYPES) {
      expect(transcript).not.toContain(type)
    }
  })
})

describe('opencode-control SQLite persistence', () => {
  it('round-trips all 10 control events through the real sqlite backend', async () => {
    // Proof 4: a real SQLite persistence backend materializes the interleaved
    // log; a FRESH backend/store instance over the same file reloads it and
    // the control events come back.
    const { dir, path } = await freshDbDir('dsh-control-')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const session = ctx.sessions.create(SessionId('control-persist'), { meta: { cwd: '/workspace' } })
    appendFixture(session, interleavedControlEvents())
    await ctx.sessions.flush(session)
    await ctx.fiber.dispose()

    // FRESH backend/store instance over the same file — no shared state.
    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const loaded = await fresh.sessionPersistence.load(SessionId('control-persist'))
    expect(loaded.meta.id).toBe('control-persist')
    const controlLoaded = loaded.events.filter(e => (CONTROL_EVENT_TYPES as readonly string[]).includes(e.type))
    expect(controlLoaded.map(e => e.type)).toEqual(CONTROL_EVENT_TYPES)
    expect(controlLoaded.length).toBe(10)
    await fresh.fiber.dispose()

    await rm(dir, { recursive: true, force: true })
  })

  it('replays the reloaded stream type-for-type, payload-for-payload, seq-for-seq', async () => {
    // Proof 5: the fresh-instance reload is a lossless replay of the original
    // in-memory stream — every field of every event is identical.
    const { dir, path } = await freshDbDir('dsh-control-replay-')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 1_000 })
    const session = ctx.sessions.create(SessionId('control-replay'), { meta: { cwd: '/workspace' } })
    appendFixture(session, interleavedControlEvents())
    await ctx.sessions.flush(session)
    const liveEvents = [...session.events]
    await ctx.fiber.dispose()

    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const loaded = await fresh.sessionPersistence.load(SessionId('control-replay'))
    expect(loaded.events).toEqual(liveEvents)
    await fresh.fiber.dispose()

    await rm(dir, { recursive: true, force: true })
  })

  it('refuses an out-of-vocabulary event type on load (fail closed)', async () => {
    // Proof 7: a persisted log containing a type outside KNOWN_SESSION_EVENT_TYPES
    // is refused on load — the fail-closed read path.
    const { dir, path } = await freshDbDir('dsh-control-unknown-')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await ctx.sessionPersistence.create({ version: 0, id: SessionId('control-unknown'), createdAt: 1000, cwd: '/workspace' })
    await ctx.sessionPersistence.append(SessionId('control-unknown'), [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'future/event', seq: 1, time: 2, data: { payload: 1 } } as unknown as SessionEvent,
    ])
    await ctx.fiber.dispose()

    const fresh = new Context()
    await fresh.plugin(SessionStore)
    await fresh.plugin(SessionPersistenceSqlite, { path })
    const failure = await fresh.sessionPersistence.load(SessionId('control-unknown')).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toMatch(/event type "future\/event".*unknown to this harness/)
    await fresh.fiber.dispose()

    await rm(dir, { recursive: true, force: true })
  })
})
