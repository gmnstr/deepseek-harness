/**
 * The derived fold — the heart of the authority inversion. `foldProjection`
 * is a PURE, deterministic function of the DSH session log: folding the same
 * events always produces an identical `DerivedSessionState`, and its digest
 * changes when any canonical fact changes. No field here may come from
 * executor or actor memory; the fold consumes only `SessionEvent` records that
 * a real DSH persistence backend loaded from the canonical log.
 *
 * Derived writes follow DSH events only. The fold itself writes nothing; the
 * runtime that owns the projection persists derived SQLite rows solely from
 * this state (delete-and-rebuild independence is asserted in tests).
 *
 * @module @deepseek-ai/dsh-opencode-execution/projection
 */

import { createHash } from 'node:crypto'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {
  ActionId,
  ExecutionId,
} from '@deepseek-ai/dsh-opencode-control'
import type {
  DerivedActivity,
  DerivedAuthority,
  DerivedEffect,
  DerivedExecution,
  DerivedSessionState,
} from './types.ts'

/**
 * Canonical serialization of one event for the digest. The fold digests
 * `type`, `seq`, and the full payload data of every native and control event
 * (native events are included so a change anywhere in the DSH log changes the
 * projection digest — the projection is a function of the whole log, not of
 * the control subset alone). Deterministic by construction: events are folded
 * in stored seq order.
 * @param event - one session event to serialize.
 * @returns the stable UTF-8 serialization consumed by the sha256 digest.
 */
function canonicalEventBytes(event: SessionEvent): string {
  const data = event.data
  return `${event.type}\u0000${String(event.seq)}\u0000${JSON.stringify(data)}`
}

/**
 * Build the fold's working execution map for a session log. `execution/
 * commanded` opens an execution; when the stream of `execution/commanded`
 * events for the same execution ends (the event order settles it), the
 * execution is marked settled. Settlement is DERIVED, never logged.
 * @param events - the contiguous log in seq order.
 * @returns the derived execution map keyed by execution id.
 */
function foldExecutions(events: readonly SessionEvent[]): ReadonlyMap<ExecutionId, DerivedExecution> {
  const executions = new Map<ExecutionId, DerivedExecution>()
  const nativeByExecution = new Map<ExecutionId, number[]>()
  for (const event of events) {
    if (event.type === 'execution/commanded') {
      const payload = event.data as SessionEventMap['execution/commanded']
      executions.set(payload.execution_id, {
        execution_id: payload.execution_id,
        command: payload.command,
        source: payload.source,
        settled: false,
        native_event_seqs: [],
      })
    } else if (event.type === 'activity/correlated') {
      const payload = event.data as SessionEventMap['activity/correlated']
      const seqs = nativeByExecution.get(payload.execution_id) ?? []
      seqs.push(payload.native_event_seq)
      nativeByExecution.set(payload.execution_id, seqs)
    }
  }
  // Settlement rule: an execution is settled when its `execution/commanded`
  // stream has ended — mirroring P0's derived-settlement rule. There is no
  // `execution/settled` control event; the fold derives it from the log.
  const result = new Map<ExecutionId, DerivedExecution>()
  for (const [id, execution] of executions) {
    result.set(id, {
      ...execution,
      settled: true,
      native_event_seqs: nativeByExecution.get(id) ?? [],
    })
  }
  return result
}

/**
 * Build the derived activity list in event order.
 * @param events - the contiguous log in seq order.
 * @returns every correlated activity in first-seen order.
 */
function foldActivities(events: readonly SessionEvent[]): readonly DerivedActivity[] {
  const activities: DerivedActivity[] = []
  for (const event of events) {
    if (event.type !== 'activity/correlated') continue
    const payload = event.data as SessionEventMap['activity/correlated']
    activities.push({
      execution_id: payload.execution_id,
      native_event_seq: payload.native_event_seq,
      kind: payload.kind,
    })
  }
  return activities
}

/**
 * Build the derived effect/authority maps in event order. Each `effect/
 * requested` opens an effect; `effect/authorized` and `effect/denied`
 * transition its authority; `effect/attempt-started` appends an attempt id;
 * the terminal events set the outcome and, for `effect/reconciled`, append
 * the reconcile attempt id as well.
 * @param events - the contiguous log in seq order.
 * @returns the derived authorities and effects keyed by action id.
 */
function foldEffects(
  events: readonly SessionEvent[],
): { authorities: ReadonlyMap<ActionId, DerivedAuthority>; effects: ReadonlyMap<ActionId, DerivedEffect> } {
  const authorities = new Map<ActionId, DerivedAuthority>()
  const effects = new Map<ActionId, DerivedEffect>()

  function update(actionId: ActionId, patch: (current: DerivedEffect | undefined) => DerivedEffect | undefined): void {
    const next = patch(effects.get(actionId))
    if (next !== undefined) effects.set(actionId, next)
  }

  for (const event of events) {
    switch (event.type) {
      case 'effect/requested': {
        const payload = event.data as SessionEventMap['effect/requested']
        authorities.set(payload.action_id, {
          action_id: payload.action_id,
          effect_class: payload.effect_class,
          authorized: false,
        })
        update(payload.action_id, current => current ?? {
          execution_id: payload.execution_id,
          action_id: payload.action_id,
          operation: payload.operation,
          resource: payload.resource,
          effect_class: payload.effect_class,
          outcome: 'requested',
          attempt_ids: [],
        })
        break
      }
      case 'effect/authorized': {
        const payload = event.data as SessionEventMap['effect/authorized']
        authorities.set(payload.action_id, {
          action_id: payload.action_id,
          effect_class: effects.get(payload.action_id)?.effect_class ?? 'unknown',
          authorized: true,
          capability_id: payload.capability_id,
        })
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'authorized', capability_id: payload.capability_id })
        break
      }
      case 'effect/denied': {
        const payload = event.data as SessionEventMap['effect/denied']
        authorities.set(payload.action_id, {
          action_id: payload.action_id,
          effect_class: effects.get(payload.action_id)?.effect_class ?? 'unknown',
          authorized: false,
          reason: payload.reason,
        })
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'denied', reason: payload.reason })
        break
      }
      case 'effect/attempt-started': {
        const payload = event.data as SessionEventMap['effect/attempt-started']
        update(payload.action_id, current => {
          if (current === undefined) return current
          // `commit-unknown` is sticky for the OUTCOME: an ambiguous
          // irreversible effect awaits reconciliation, so a reconcile probe's
          // attempt-started must not regress the outcome back to
          // 'attempt-started'. Terminal outcomes (succeeded/reconciled) are
          // never regressed either. But the attempt identity is ALWAYS
          // appended: a reconcile probe's attempt-started (e.g.
          // `act:1:reconcile:1`) is a canonical fact that later terminal
          // events (failEffect/succeedEffect/commitUnknown) reference via
          // requireAttemptStarted.
          const outcome = current.outcome === 'succeeded' || current.outcome === 'reconciled'
            ? current.outcome
            : current.outcome === 'commit-unknown'
              ? 'commit-unknown'
              : 'attempt-started'
          return { ...current, outcome, attempt_ids: [...current.attempt_ids, payload.attempt_id] }
        })
        break
      }
      case 'effect/succeeded': {
        const payload = event.data as SessionEventMap['effect/succeeded']
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'succeeded', receipt: payload.receipt })
        break
      }
      case 'effect/failed': {
        const payload = event.data as SessionEventMap['effect/failed']
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'failed', error: payload.error })
        break
      }
      case 'effect/commit-unknown': {
        const payload = event.data as SessionEventMap['effect/commit-unknown']
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'commit-unknown' })
        break
      }
      case 'effect/reconciled': {
        const payload = event.data as SessionEventMap['effect/reconciled']
        // The reconcile probe's attempt-started already appended the attempt id
        // (see `effect/attempt-started`); this terminal event only resolves the
        // outcome. Not appending here avoids recording the same attempt twice.
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'reconciled', receipt: payload.receipt })
        break
      }
      default:
        break
    }
  }
  return { authorities, effects }
}

/**
 * Fold a DSH session log (native + control events) into the derived session
 * state. PURE and deterministic: the same events always produce an identical
 * state, and the sha256 digest changes when any event's type, seq, or data
 * changes. Derived state is a function of the DSH log alone.
 * @param events - the contiguous session log in seq order.
 * @param sessionId - the session whose log is folded.
 * @returns the derived read model with its digest.
 */
export function foldProjection(events: readonly SessionEvent[], sessionId: string): DerivedSessionState {
  const executions = foldExecutions(events)
  const activities = foldActivities(events)
  const { authorities, effects } = foldEffects(events)
  const digest = createHash('sha256')
  for (const event of events) digest.update(canonicalEventBytes(event))
  return {
    session_id: sessionId,
    last_seq: events.length === 0 ? -1 : (events[events.length - 1] as SessionEvent).seq,
    executions,
    activities,
    authorities,
    effects,
    digest: digest.digest('hex'),
  }
}
