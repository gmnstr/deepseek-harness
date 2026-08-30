/**
 * The serialized session actor of the derived execution runtime. Every
 * canonical write goes through `appendFenced` on real DSH persistence using
 * the A1 control-event factories — the ONLY write path. The runtime holds no
 * in-memory authoritative state: every decision is re-derived from the DSH
 * log before acting (a projection cache is allowed only when it is provably
 * derived; this runtime re-derives for honesty). Ownership migrates through
 * `advanceOwnershipEpoch` CAS — NEVER an `OwnershipMigrated` control event
 * (fencing is persistence metadata, not an event, per the A1 decision).
 *
 * @module @deepseek-ai/dsh-opencode-execution/execution-runtime
 */

import type { SessionId, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {
  ActionId,
  AttemptId,
  ExecutionId,
} from '@deepseek-ai/dsh-opencode-control'
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
import type {
  SessionPersistence,
  WriterEpochToken,
} from '@deepseek-ai/dsh-session-persistence'
import type { SqliteSessionPersistence } from '@deepseek-ai/dsh-session-persistence-sqlite'
import type { DerivedSessionState, ProjectionWriter } from './types.ts'
import { foldProjection } from './projection.ts'

/** One canonical control event awaiting an append, narrowed by the caller. */
export type ControlAppend = {
  [Type in 'execution/commanded' | 'activity/correlated' | 'effect/requested'
    | 'effect/authorized' | 'effect/denied' | 'effect/attempt-started'
    | 'effect/succeeded' | 'effect/failed' | 'effect/commit-unknown' | 'effect/reconciled']: {
    type: Type
    data: SessionEventMap[Type]
  }
}[
  'execution/commanded' | 'activity/correlated' | 'effect/requested'
    | 'effect/authorized' | 'effect/denied' | 'effect/attempt-started'
    | 'effect/succeeded' | 'effect/failed' | 'effect/commit-unknown' | 'effect/reconciled'
]

/** Context the runtime appends under. */
export interface ExecutionRuntimeOptions {
  /**
   * The fenced session persistence backend. The runtime needs the concrete
   * SQLite service because ownership migration (`advanceOwnershipEpoch`) is a
   * store-level CAS that the abstract seam does not declare; other backends
   * that want to host the runtime must expose the same surface.
   */
  readonly persistence: SqliteSessionPersistence
  /** The session the runtime owns. */
  readonly session_id: SessionId
  /** The writer token; the runtime mutates it only through migration. */
  readonly writer: ProjectionWriter
}

/** A canonical append was rejected because the writer no longer owns the epoch. */
export class SessionOwnershipFencedError extends Error {
  /** @param message - the fence detail. */
  constructor(message: string) {
    super(message)
    this.name = 'SessionOwnershipFencedError'
  }
}

/** The runtime rejected an out-of-order control transition. */
export class ControlTransitionError extends Error {
  /** @param message - the transition detail. */
  constructor(message: string) {
    super(message)
    this.name = 'ControlTransitionError'
  }
}

/**
 * Load the canonical DSH log tail of the runtime's session. Uses `inspect`
 * (not `load`) so a freshly created, not-yet-materialized live session can be
 * read: `load` rejects a live empty session before its first flush, while the
 * runtime's first `appendFenced` materializes it. A session the backend has
 * not materialized yet reads as an empty log — the runtime's first append
 * starts at seq 0.
 * @param persistence - the fenced backend.
 * @param sessionId - the owned session.
 * @returns the events of the whole log (empty when not yet materialized).
 */
async function loadLog(persistence: SessionPersistence, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  try {
    const inspection = await persistence.inspect(sessionId)
    return inspection.events
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return []
    throw error
  }
}

/**
 * Serialized session actor that writes control facts canonically through
 * fenced DSH persistence. Lifecycle ordering (P0–P3 error semantics):
 * an execution must be commanded before its activity is correlated; an effect
 * must be requested before it is authorized/denied; an effect result requires
 * a prior authorization — the same error strings the P0–P3 prototype used.
 */
export class ExecutionRuntime {
  /** The fenced SQLite persistence backend all canonical writes go through. */
  readonly persistence: SqliteSessionPersistence
  /** The session the runtime owns and serializes. */
  readonly session_id: SessionId
  /** The writer token; ownership_epoch/worker_id mutate only via migrateOwnership. */
  writer: ProjectionWriter

  /**
   * @param options - persistence, session, and initial writer token.
   */
  constructor(options: ExecutionRuntimeOptions) {
    this.persistence = options.persistence
    this.session_id = options.session_id
    this.writer = { ...options.writer }
  }

  /**
   * Re-derive the current projection from the canonical DSH log. Every
   * decision in this runtime consults this derived state before acting.
   * @returns the derived session state.
   */
  async derive(): Promise<DerivedSessionState> {
    const events = await loadLog(this.persistence, this.session_id)
    return foldProjection(events, String(this.session_id))
  }

  /**
   * The ONLY canonical write entry point: build one full `SessionEvent`
   * (seq continues the stored DSH log cursor) and append it fenced. A stale
   * writer is rejected by the backend's in-transaction epoch assert.
   * @param type - the control event type.
   * @param data - the factory-built durable payload.
   */
  async appendControl<Type extends ControlAppend['type']>(
    type: Type,
    data: SessionEventMap[Type],
  ): Promise<void> {
    const events = await loadLog(this.persistence, this.session_id)
    const seq = events.length === 0 ? 0 : (events[events.length - 1] as SessionEvent).seq + 1
    const event = { type, seq, time: Date.now(), data } as SessionEvent
    await this.persistence.appendFenced(this.session_id, [event], this.writer as WriterEpochToken)
  }

  /**
   * Append `execution/commanded` — the durable record that one execution unit
   * was commanded under an execution id.
   * @param execution_id - the execution being commanded.
   * @param command - the exact command string issued.
   * @param source - provenance (surface, automation, hook).
   */
  async beginExecution(execution_id: ExecutionId, command: string, source: string): Promise<void> {
    await this.appendControl('execution/commanded', executionCommanded({ execution_id, command, source }))
  }

  /**
   * Append `activity/correlated` — correlate one native activity to an
   * execution. Rejects when the execution has no prior `execution/commanded`.
   * @param execution_id - the execution the activity belongs to.
   * @param native_event_seq - the native event's sequence in its source stream.
   * @param kind - the native event kind tag.
   */
  async correlateActivity(execution_id: ExecutionId, native_event_seq: number, kind: string): Promise<void> {
    const derived = await this.derive()
    if (!derived.executions.has(execution_id)) {
      throw new ControlTransitionError(
        `activity correlation without commanded execution: execution ${execution_id}`,
      )
    }
    await this.appendControl('activity/correlated', activityCorrelated({ execution_id, native_event_seq, kind }))
  }

  /**
   * Append `effect/requested` — the earliest durable record of intent to
   * mutate. Rejects when the execution has no prior `execution/commanded`.
   * @param execution_id - the execution requesting the effect.
   * @param action_id - the logical action being requested.
   * @param operation - the mutation operation (create, write, execute, delete).
   * @param resource - the addressed resource path or name.
   * @param effect_class - the authority class that must decide it.
   */
  async requestEffect(
    execution_id: ExecutionId,
    action_id: ActionId,
    operation: string,
    resource: string,
    effect_class: string,
  ): Promise<void> {
    const derived = await this.derive()
    if (!derived.executions.has(execution_id)) {
      throw new ControlTransitionError(
        `effect request without commanded execution: execution ${execution_id}`,
      )
    }
    await this.appendControl('effect/requested', effectRequested({
      execution_id,
      action_id,
      operation,
      resource,
      effect_class,
    }))
  }

  /**
   * Append `effect/authorized` — a capability granted the requested effect.
   * Rejects when the action has no prior `effect/requested`.
   * @param execution_id - the execution that requested the effect.
   * @param action_id - the action being granted.
   * @param capability_id - the capability id that authorized it.
   */
  async authorizeEffect(execution_id: ExecutionId, action_id: ActionId, capability_id: string): Promise<void> {
    const derived = await this.derive()
    if (!derived.effects.has(action_id)) {
      throw new ControlTransitionError(
        `effect authorization without corresponding canonical request: action ${action_id}`,
      )
    }
    await this.appendControl('effect/authorized', effectAuthorized({ execution_id, action_id, capability_id }))
  }

  /**
   * Append `effect/denied` — an authority refused the requested effect.
   * Rejects when the action has no prior `effect/requested`.
   * @param execution_id - the execution that requested the effect.
   * @param action_id - the action being refused.
   * @param reason - the authority's human-readable refusal.
   */
  async denyEffect(execution_id: ExecutionId, action_id: ActionId, reason: string): Promise<void> {
    const derived = await this.derive()
    if (!derived.effects.has(action_id)) {
      throw new ControlTransitionError(
        `effect denial without corresponding canonical request: action ${action_id}`,
      )
    }
    await this.appendControl('effect/denied', effectDenied({ execution_id, action_id, reason }))
  }

  /**
   * Append `effect/attempt-started` — execution of an authorized effect began.
   * Rejects when the action was never authorized or already reached a terminal
   * success/reconciliation. Retry attempts (after `effect/failed`) and
   * reconciliation probes (after `effect/commit-unknown`) are allowed — the
   * P2 loop continues an authorized action until terminal.
   * @param execution_id - the execution that requested the effect.
   * @param action_id - the action being attempted.
   * @param attempt_id - the fresh attempt id.
   */
  async startAttempt(execution_id: ExecutionId, action_id: ActionId, attempt_id: AttemptId): Promise<void> {
    const derived = await this.derive()
    const effect = derived.effects.get(action_id)
    if (effect === undefined || effect.outcome === 'requested' || effect.outcome === 'denied'
      || effect.outcome === 'succeeded' || effect.outcome === 'reconciled') {
      throw new ControlTransitionError(
        `effect attempt without authorization: action ${action_id}`,
      )
    }
    await this.appendControl('effect/attempt-started', effectAttemptStarted({ execution_id, action_id, attempt_id }))
  }

  /**
   * Append `effect/succeeded` — the attempt completed successfully.
   * Rejects when the attempt has no prior `effect/attempt-started`.
   * @param execution_id - the execution that requested the effect.
   * @param action_id - the action that succeeded.
   * @param attempt_id - the attempt that succeeded.
   * @param receipt - the opaque outcome payload.
   */
  async succeedEffect(
    execution_id: ExecutionId,
    action_id: ActionId,
    attempt_id: AttemptId,
    receipt: unknown,
  ): Promise<void> {
    await this.requireAttemptStarted(action_id, attempt_id)
    await this.appendControl('effect/succeeded', effectSucceeded({ execution_id, action_id, attempt_id, receipt }))
  }

  /**
   * Append `effect/failed` — the attempt failed.
   * @param execution_id - the execution that requested the effect.
   * @param action_id - the action that failed.
   * @param attempt_id - the attempt that failed.
   * @param error - the stable machine-readable failure string.
   */
  async failEffect(execution_id: ExecutionId, action_id: ActionId, attempt_id: AttemptId, error: string): Promise<void> {
    await this.requireAttemptStarted(action_id, attempt_id)
    await this.appendControl('effect/failed', effectFailed({ execution_id, action_id, attempt_id, error }))
  }

  /**
   * Append `effect/commit-unknown` — the attempt's outcome is unknown.
   * @param execution_id - the execution that requested the effect.
   * @param action_id - the action whose outcome is unknown.
   * @param attempt_id - the attempt whose outcome is unknown.
   */
  async commitUnknown(execution_id: ExecutionId, action_id: ActionId, attempt_id: AttemptId): Promise<void> {
    await this.requireAttemptStarted(action_id, attempt_id)
    await this.appendControl('effect/commit-unknown', effectCommitUnknown({ execution_id, action_id, attempt_id }))
  }

  /**
   * Append `effect/reconciled` — an earlier unknown attempt was reconciled to
   * a definite outcome. Accepts an action whose derived state is AMBIGUOUS:
   * either an explicit `effect/commit-unknown` outcome or an orphaned
   * `effect/attempt-started` with no terminal event after it (a worker killed
   * between dispatch and outcome — the crash-window ambiguity, FR-1). Both are
   * reconciled via a probe that checks external state, never a blind re-dispatch.
   * @param execution_id - the execution that requested the effect.
   * @param action_id - the action that was reconciled.
   * @param attempt_id - the attempt that was reconciled.
   * @param receipt - the recovered outcome payload.
   */
  async reconcileEffect(
    execution_id: ExecutionId,
    action_id: ActionId,
    attempt_id: AttemptId,
    receipt: unknown,
  ): Promise<void> {
    const derived = await this.derive()
    const effect = derived.effects.get(action_id)
    if (effect === undefined || !effect.ambiguous) {
      throw new ControlTransitionError(
        `reconcile for action ${action_id} in state ${effect?.outcome ?? '(none)'}: only an ambiguous (commit-unknown or orphaned-attempt) action can be reconciled`,
      )
    }
    await this.appendControl('effect/reconciled', effectReconciled({ execution_id, action_id, attempt_id, receipt }))
  }

  /**
   * Migrate ownership with an atomic CAS: `advanceOwnershipEpoch(fromEpoch,
   * toEpoch)` must win before the runtime adopts the new identity. Never
   * appends an `OwnershipMigrated` control event — fencing is persistence
   * metadata, not an event.
   * @param fromEpoch - epoch the runtime currently owns.
   * @param toEpoch - strictly greater epoch the runtime claims.
   * @param newWorkerId - the new worker identity.
   * @throws `SessionOwnershipFencedError` when the CAS loses the migration.
   */
  async migrateOwnership(fromEpoch: number, toEpoch: number, newWorkerId: string): Promise<void> {
    const advanced = await this.persistence.advanceOwnershipEpoch(this.session_id, fromEpoch, toEpoch)
    if (!advanced) {
      throw new SessionOwnershipFencedError(
        `ownership migration fenced: ${this.writer.worker_id} epoch ${fromEpoch} -> ${toEpoch} (another writer advanced first)`,
      )
    }
    this.writer = { worker_id: newWorkerId, ownership_epoch: toEpoch }
  }

  /** Require a prior `effect/attempt-started` for the action+attempt pair. */
  private async requireAttemptStarted(action_id: ActionId, attempt_id: AttemptId): Promise<void> {
    const derived = await this.derive()
    const effect = derived.effects.get(action_id)
    if (effect === undefined || !effect.attempt_ids.includes(attempt_id)) {
      throw new ControlTransitionError(
        `effect result without prior attempt: action ${action_id} attempt ${attempt_id}`,
      )
    }
  }
}
