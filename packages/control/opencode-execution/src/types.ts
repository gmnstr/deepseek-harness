/**
 * Type-only read-model contracts for the derived-projection execution runtime.
 * Every value here is DERIVED from the canonical DSH session log — none of
 * these fields may ever come from executor or actor memory. The runtime writes
 * control facts canonically through fenced DSH persistence (`appendFenced`);
 * this module only names the fold results and the writer token.
 *
 * @module @deepseek-ai/dsh-opencode-execution/types
 */

import type { ActionId, AttemptId, ExecutionId } from '@deepseek-ai/dsh-opencode-control'

/**
 * One commanded execution unit derived from `execution/commanded` events.
 * Settlement is DERIVED, never logged: when the `execution/commanded` stream
 * of the same execution ends, the projection marks the execution settled
 * (mirroring the P0 derived-settlement rule).
 */
export interface DerivedExecution {
  /** The commanded execution unit. */
  readonly execution_id: ExecutionId
  /** The exact command string issued. */
  readonly command: string
  /** Provenance of the command (surface, automation, hook). */
  readonly source: string
  /** Whether the execution's `execution/commanded` stream has ended. */
  readonly settled: boolean
  /** The native event seqs correlated to this execution, in order. */
  readonly native_event_seqs: readonly number[]
}

/**
 * One native activity correlated to an execution, derived from
 * `activity/correlated` events.
 */
export interface DerivedActivity {
  /** The execution the native activity belongs to. */
  readonly execution_id: ExecutionId
  /** The native event's sequence number in its source stream. */
  readonly native_event_seq: number
  /** The native event kind tag. */
  readonly kind: string
}

/**
 * The current authority status of one effect request, derived from the
 * `effect/*` control events.
 */
export interface DerivedAuthority {
  /** The action whose authority is tracked. */
  readonly action_id: ActionId
  /** The authority class that must decide the effect. */
  readonly effect_class: string
  /** Whether the effect was authorized (via a typed capability). */
  readonly authorized: boolean
  /** The capability id that authorized the effect, when authorized. */
  readonly capability_id?: string
  /** The authority's refusal reason, when denied. */
  readonly reason?: string
}

/**
 * Terminal outcome of one effect action, as derived from the `effect/*`
 * control event stream. `none` means the action has not reached a terminal
 * `effect/succeeded` / `effect/failed` / `effect/commit-unknown` /
 * `effect/reconciled` event yet.
 */
export type DerivedEffectOutcome =
  | 'none'
  | 'requested'
  | 'authorized'
  | 'denied'
  | 'attempt-started'
  | 'succeeded'
  | 'failed'
  | 'commit-unknown'
  | 'reconciled'

/**
 * One effect action's derived lifecycle state, folded from `effect/*` events.
 */
export interface DerivedEffect {
  /** The execution that requested the effect. */
  readonly execution_id: ExecutionId
  /** The logical action being tracked; retries reuse it. */
  readonly action_id: ActionId
  /** The mutation operation (create, write, execute, delete). */
  readonly operation: string
  /** The addressed resource path or name. */
  readonly resource: string
  /** The authority class that must decide the effect. */
  readonly effect_class: string
  /** The effect's derived outcome. */
  readonly outcome: DerivedEffectOutcome
  /** The capability id that authorized the effect, when authorized. */
  readonly capability_id?: string
  /** The authority's refusal reason, when denied. */
  readonly reason?: string
  /** Every concrete attempt id recorded for the action, in order. */
  readonly attempt_ids: readonly AttemptId[]
  /** The outcome receipt of the last terminal event, when present. */
  readonly receipt?: unknown
  /** The stable machine-readable failure of the last failure, when present. */
  readonly error?: string
  /**
   * True when the action has an ORPHANED attempt: an `effect/attempt-started`
   * was recorded but no terminal event followed it (the worker was killed
   * between dispatch and outcome, so the external mutation may have committed
   * and its response was lost). This is the crash-window ambiguity fact — the
   * attempt must be reconciled (never re-dispatched under a fresh execute()).
   * `ambiguous` is a DERIVED fact from the canonical log, distinct from the
   * explicit `commit-unknown` outcome (an orphaned attempt has no
   * `effect/commit-unknown` event).
   */
  readonly ambiguous: boolean
}

/**
 * The complete derived read model of one session's control plane. This state
 * is a PURE function of the DSH log alone — folding the same events always
 * yields an identical state, and its `digest` changes when any canonical fact
 * changes.
 */
export interface DerivedSessionState {
  /** The session whose log was folded. */
  readonly session_id: string
  /** The last sequence number present in the folded log. */
  readonly last_seq: number
  /** Every commanded execution, keyed by execution id in first-seen order. */
  readonly executions: ReadonlyMap<ExecutionId, DerivedExecution>
  /** Every correlated native activity, in event order. */
  readonly activities: readonly DerivedActivity[]
  /** Every effect authority decision, keyed by action id. */
  readonly authorities: ReadonlyMap<ActionId, DerivedAuthority>
  /** Every effect lifecycle, keyed by action id. */
  readonly effects: ReadonlyMap<ActionId, DerivedEffect>
  /** sha256 hex digest over the canonical facts of the folded log. */
  readonly digest: string
}

/**
 * The writer-owned token the derived runtime appends under. Mirrors
 * `WriterEpochToken` from `@deepseek-ai/dsh-session-persistence`: the epoch is
 * durable per session, the worker id names the writer for diagnostics.
 */
export interface ProjectionWriter {
  /** Identity of the worker process that owns the epoch. */
  readonly worker_id: string
  /** The durable ownership epoch the writer claims for the session. */
  readonly ownership_epoch: number
}
