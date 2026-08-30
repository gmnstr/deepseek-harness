/**
 * A7 execution-settlement discriminator. The reviewer's retained hypothesis:
 * "there are currently no more events" is NOT inherently equivalent to "the
 * execution reached a terminal state." The A1 decision says settlement is
 * derived, not logged — so the derivation must rest on CANONICAL facts, not on
 * a reader-position artifact (the fold having reached the end of the log).
 *
 * The predicate: an execution is settled when every effect it requested has
 * reached a terminal derived outcome (succeeded / failed / reconciled /
 * denied). An execution with a pending (`requested` / `authorized` /
 * `attempt-started`) or ambiguous (`commit-unknown`) effect is NOT settled. An
 * execution that requested no effects is settled by construction.
 *
 * This is the honest discriminator for the settlement hypothesis: the fold
 * must not report "settled" merely because the log currently ends after the
 * last `execution/commanded`.
 * @module @deepseek-ai/dsh-opencode-execution/tests/a7-execution-settlement
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ActionId, AttemptId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import {
  effectAttemptStarted,
  effectAuthorized,
  effectCommitUnknown,
  effectReconciled,
  effectRequested,
  effectSucceeded,
  executionCommanded,
} from '@deepseek-ai/dsh-opencode-control'
import { foldProjection } from '../src/projection.ts'

const EXEC = ExecutionId('exec-1')
const ACTION = ActionId('act-1')
const ATTEMPT = AttemptId('act-1:1')
const RECONCILE = AttemptId('act-1:reconcile:1')

function eventsOf(fixtures: Array<{ type: string; data: Record<string, unknown> }>): SessionEvent[] {
  return fixtures.map((fixture, seq) => ({
    type: fixture.type as SessionEvent['type'],
    seq,
    time: 1_000 + seq,
    data: fixture.data as SessionEvent['data'],
  } as SessionEvent))
}

describe('execution settlement is derived from canonical terminal facts', () => {
  it('an execution with NO effects is settled by construction', () => {
    const state = foldProjection(eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'git status', source: 'surface' }) },
    ]), 'settle-1')
    expect(state.executions.get(EXEC)?.settled).toBe(true)
  })

  it('an execution with a pending (requested/authorized/attempt-started) effect is NOT settled', () => {
    const pending = eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'x', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: EXEC, action_id: ACTION, operation: 'write', resource: '/w/a', effect_class: 'filesystem' }) },
    ])
    expect(foldProjection(pending, 'settle-2').executions.get(EXEC)?.settled).toBe(false)

    const authorized = eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'x', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: EXEC, action_id: ACTION, operation: 'write', resource: '/w/a', effect_class: 'filesystem' }) },
      { type: 'effect/authorized', data: effectAuthorized({ execution_id: EXEC, action_id: ACTION, capability_id: 'cap' }) },
    ])
    expect(foldProjection(authorized, 'settle-2').executions.get(EXEC)?.settled).toBe(false)

    const started = eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'x', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: EXEC, action_id: ACTION, operation: 'write', resource: '/w/a', effect_class: 'filesystem' }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXEC, action_id: ACTION, attempt_id: ATTEMPT }) },
    ])
    expect(foldProjection(started, 'settle-2').executions.get(EXEC)?.settled).toBe(false)
  })

  it('an execution with an AMBIGUOUS (commit-unknown) effect is NOT settled', () => {
    // The decisive discriminator: the log "ends here" but the effect outcome is
    // commit-unknown (request sent, external may have committed, response lost).
    // Reporting this execution as settled would hide a pending reconciliation.
    const ambiguous = eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'apply patch', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: EXEC, action_id: ACTION, operation: 'patch', resource: '/srv/app/seed.json', effect_class: 'irreversible' }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXEC, action_id: ACTION, attempt_id: ATTEMPT }) },
      { type: 'effect/commit-unknown', data: effectCommitUnknown({ execution_id: EXEC, action_id: ACTION, attempt_id: ATTEMPT }) },
    ])
    const state = foldProjection(ambiguous, 'settle-3')
    expect(state.effects.get(ACTION)?.outcome).toBe('commit-unknown')
    expect(state.executions.get(EXEC)?.settled).toBe(false)
  })

  it('an execution becomes settled once its ambiguous effect is reconciled', () => {
    const reconciled = eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'apply patch', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: EXEC, action_id: ACTION, operation: 'patch', resource: '/srv/app/seed.json', effect_class: 'irreversible' }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXEC, action_id: ACTION, attempt_id: ATTEMPT }) },
      { type: 'effect/commit-unknown', data: effectCommitUnknown({ execution_id: EXEC, action_id: ACTION, attempt_id: ATTEMPT }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXEC, action_id: ACTION, attempt_id: RECONCILE }) },
      { type: 'effect/reconciled', data: effectReconciled({ execution_id: EXEC, action_id: ACTION, attempt_id: RECONCILE, receipt: { ok: true } }) },
    ])
    const state = foldProjection(reconciled, 'settle-4')
    expect(state.effects.get(ACTION)?.outcome).toBe('reconciled')
    expect(state.executions.get(EXEC)?.settled).toBe(true)
  })

  it('an execution with a denied effect is settled (denial is terminal)', () => {
    const denied = eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'delete', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: EXEC, action_id: ACTION, operation: 'delete', resource: '/tmp/x', effect_class: 'sandbox' }) },
    ])
    // Append the denial directly as the canonical terminal event.
    denied.push({
      type: 'effect/denied',
      seq: denied.length,
      time: 1_000 + denied.length,
      data: { version: 1, execution_id: EXEC, action_id: ACTION, reason: 'sandbox denies' },
    } as SessionEvent)
    const state = foldProjection(denied, 'settle-5')
    expect(state.effects.get(ACTION)?.outcome).toBe('denied')
    expect(state.executions.get(EXEC)?.settled).toBe(true)
  })

  it('a failed effect is terminal: the execution settles', () => {
    const failed = eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: EXEC, command: 'write', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: EXEC, action_id: ACTION, operation: 'write', resource: '/w/a', effect_class: 'filesystem' }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: EXEC, action_id: ACTION, attempt_id: ATTEMPT }) },
    ])
    failed.push({
      type: 'effect/failed',
      seq: failed.length,
      time: 1_000 + failed.length,
      data: { version: 1, execution_id: EXEC, action_id: ACTION, attempt_id: ATTEMPT, error: 'EACCES' },
    } as SessionEvent)
    const state = foldProjection(failed, 'settle-6')
    expect(state.effects.get(ACTION)?.outcome).toBe('failed')
    expect(state.executions.get(EXEC)?.settled).toBe(true)
  })

  it('another execution OWNING a pending effect does not settle an execution with all-terminal effects', () => {
    // Execution 1 has a succeeded effect (terminal); execution 2 has a pending
    // one. Settlement must be per-execution, never global.
    const exec1 = ExecutionId('exec-1')
    const exec2 = ExecutionId('exec-2')
    const action1 = ActionId('act-1')
    const action2 = ActionId('act-2')
    const attempt1 = AttemptId('act-1:1')
    const attempt2 = AttemptId('act-2:1')
    const state = foldProjection(eventsOf([
      { type: 'execution/commanded', data: executionCommanded({ execution_id: exec1, command: 'a', source: 'surface' }) },
      { type: 'execution/commanded', data: executionCommanded({ execution_id: exec2, command: 'b', source: 'surface' }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: exec1, action_id: action1, operation: 'write', resource: '/w/1', effect_class: 'filesystem' }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: exec1, action_id: action1, attempt_id: attempt1 }) },
      { type: 'effect/succeeded', data: effectSucceeded({ execution_id: exec1, action_id: action1, attempt_id: attempt1, receipt: { ok: true } }) },
      { type: 'effect/requested', data: effectRequested({ execution_id: exec2, action_id: action2, operation: 'write', resource: '/w/2', effect_class: 'filesystem' }) },
      { type: 'effect/attempt-started', data: effectAttemptStarted({ execution_id: exec2, action_id: action2, attempt_id: attempt2 }) },
    ]), 'settle-7')
    expect(state.executions.get(exec1)?.settled).toBe(true)
    expect(state.executions.get(exec2)?.settled).toBe(false)
  })
})
