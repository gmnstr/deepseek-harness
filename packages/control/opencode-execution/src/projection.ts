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
  DerivedEffectOutcome,
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
 * commanded` opens an execution. Settlement is DERIVED, never logged: an
 * execution is settled when every effect it requested reached a terminal
 * derived outcome (`succeeded` / `failed` / `reconciled` / `denied`). An
 * execution with a pending or ambiguous effect (`requested` / `authorized` /
 * `attempt-started` / `commit-unknown`) is NOT settled — the fold never
 * conflates "the log happens to end here" with "the execution reached a
 * terminal state." An execution that requested no effects is settled by
 * construction.
 * @param events - the contiguous log in seq order.
 * @param effects - the derived effect map (needed to test effect terminals).
 * @returns the derived execution map keyed by execution id.
 */
function foldExecutions(
  events: readonly SessionEvent[],
  effects: ReadonlyMap<ActionId, DerivedEffect>,
): ReadonlyMap<ExecutionId, DerivedExecution> {
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
  const terminal = new Set<DerivedEffectOutcome>(['succeeded', 'failed', 'reconciled', 'denied'])
  const result = new Map<ExecutionId, DerivedExecution>()
  for (const [id, execution] of executions) {
    // Every effect requested by THIS execution must have reached a terminal
    // outcome. Effects owned by other executions never affect it; an execution
    // with no effects is trivially settled.
    const ownedEffects = [...effects.values()].filter(effect => effect.execution_id === id)
    const settled = ownedEffects.every(effect => terminal.has(effect.outcome))
    result.set(id, {
      ...execution,
      settled,
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
  // Per-action set of attempt ids that reached a terminal event
  // (effect/succeeded | effect/failed | effect/commit-unknown | effect/reconciled).
  const terminalAttempts = new Map<ActionId, Set<string>>()

  function update(actionId: ActionId, patch: (current: DerivedEffect | undefined) => DerivedEffect | undefined): void {
    const next = patch(effects.get(actionId))
    if (next !== undefined) effects.set(actionId, next)
  }

  // Recompute the derived `ambiguous` flag for an action from the canonical
  // terminal-attempt coverage. An action is ambiguous when (a) its resolved
  // outcome is an explicit `effect/commit-unknown` (request sent, external may
  // have committed, response lost), or (b) its outcome is still in-flight and
  // its LAST recorded attempt has no terminal event — the crash-window fact
  // that a worker was killed between dispatch and outcome, leaving the external
  // mutation's fate unknown. Once a terminal event resolves the action
  // (succeeded/reconciled/failed/denied), the ambiguity clears. `ambiguous` is
  // DERIVED from the canonical log, never an event.
  function deriveAmbiguous(effect: DerivedEffect | undefined): boolean {
    if (effect === undefined) return false
    if (effect.outcome === 'succeeded' || effect.outcome === 'reconciled'
      || effect.outcome === 'failed' || effect.outcome === 'denied') {
      return false
    }
    if (effect.outcome === 'commit-unknown') return true
    const covered = terminalAttempts.get(effect.action_id) ?? new Set<string>()
    const lastAttempt = effect.attempt_ids.at(-1)
    return lastAttempt !== undefined && !covered.has(String(lastAttempt))
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
          ambiguous: false,
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
        update(payload.action_id, (current) => {
          if (current === undefined) return current
          const next = { ...current, outcome: 'authorized' as const, capability_id: payload.capability_id }
          return { ...next, ambiguous: deriveAmbiguous(next) }
        })
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
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'denied', reason: payload.reason, ambiguous: false })
        break
      }
      case 'effect/attempt-started': {
        const payload = event.data as SessionEventMap['effect/attempt-started']
        update(payload.action_id, (current) => {
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
          const outcome: DerivedEffect['outcome'] = current.outcome === 'succeeded' || current.outcome === 'reconciled'
            ? current.outcome
            : current.outcome === 'commit-unknown'
              ? 'commit-unknown'
              : 'attempt-started'
          const next = { ...current, outcome, attempt_ids: [...current.attempt_ids, payload.attempt_id] }
          return { ...next, ambiguous: deriveAmbiguous(next) }
        })
        break
      }
      case 'effect/succeeded':
      case 'effect/failed':
      case 'effect/reconciled': {
        const payload = event.data as SessionEventMap['effect/succeeded'] & SessionEventMap['effect/failed'] & SessionEventMap['effect/reconciled']
        const covered = terminalAttempts.get(payload.action_id) ?? new Set<string>()
        covered.add(String(payload.attempt_id))
        terminalAttempts.set(payload.action_id, covered)
        // effect/succeeded and effect/failed record their outcome directly;
        // effect/reconciled records the recovered outcome of an earlier
        // ambiguous attempt (its probe's attempt-started already appended the
        // attempt id — see `effect/attempt-started`). In every case the
        // terminal outcome clears the derived ambiguity.
        update(payload.action_id, (current) => {
          if (current === undefined) return current
          const next = {
            ...current,
            outcome: event.type === 'effect/succeeded' ? 'succeeded' as const
              : event.type === 'effect/failed' ? 'failed' as const
                : 'reconciled' as const,
            ...(event.type === 'effect/failed' ? { error: payload.error } : { receipt: payload.receipt }),
          }
          return { ...next, ambiguous: deriveAmbiguous(next) }
        })
        break
      }
      case 'effect/commit-unknown': {
        const payload = event.data as SessionEventMap['effect/commit-unknown']
        const covered = terminalAttempts.get(payload.action_id) ?? new Set<string>()
        covered.add(String(payload.attempt_id))
        terminalAttempts.set(payload.action_id, covered)
        // commit-unknown is sticky for the outcome; the ambiguity fact stays
        // true until a reconcile terminal event resolves the action.
        update(payload.action_id, current => current === undefined ? current : { ...current, outcome: 'commit-unknown', ambiguous: true })
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
  const { authorities, effects } = foldEffects(events)
  const executions = foldExecutions(events, effects)
  const activities = foldActivities(events)
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
