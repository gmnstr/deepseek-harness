/**
 * Control-plane execution and effect audit events for the DeepSeek Harness
 * session log: typed factories and branded ids that build the durable
 * log-only payloads of the opencode control surface. The `SessionEventMap`
 * merge lives in `./types.ts`; this module carries no cordis service —
 * consumers append the factory payloads through their own Session.
 *
 * @module @deepseek-ai/dsh-opencode-control
 */

import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ActionId, AttemptId, ExecutionId } from './types.ts'

export { ActionId, AttemptId, ExecutionId } from './types.ts'
export type * from './types.ts'

/**
 * The data payload of one control event type — the exact `data` field of the
 * {@link SessionEvent} whose type is `Type`.
 */
export type DshControlPayload<Type extends keyof SessionEventMap> = SessionEventMap[Type]

/** Payload inputs for {@link executionCommanded}. */
export interface ExecutionCommandedInput {
  /** The execution unit that was commanded. */
  execution_id: ExecutionId
  /** The exact command string issued. */
  command: string
  /** Provenance of the command (surface, automation, hook). */
  source: string
}

/** Payload inputs for {@link activityCorrelated}. */
export interface ActivityCorrelatedInput {
  /** The execution the native activity belongs to. */
  execution_id: ExecutionId
  /** The native event's sequence number in its source stream. */
  native_event_seq: number
  /** The native event kind tag. */
  kind: string
}

/** Payload inputs for {@link effectRequested}. */
export interface EffectRequestedInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action being requested. */
  action_id: ActionId
  /** The mutation operation (create, write, execute, delete). */
  operation: string
  /** The addressed resource path or name. */
  resource: string
  /** The authority class that must decide it. */
  effect_class: string
}

/** Payload inputs for {@link effectAuthorized}. */
export interface EffectAuthorizedInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action being granted. */
  action_id: ActionId
  /** The capability id that authorized it. */
  capability_id: string
}

/** Payload inputs for {@link effectDenied}. */
export interface EffectDeniedInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action being refused. */
  action_id: ActionId
  /** The authority's human-readable refusal. */
  reason: string
}

/** Payload inputs for {@link effectAttemptStarted}. */
export interface EffectAttemptStartedInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action being attempted. */
  action_id: ActionId
  /** The fresh attempt id. */
  attempt_id: AttemptId
}

/** Payload inputs for {@link effectSucceeded}. */
export interface EffectSucceededInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action that succeeded. */
  action_id: ActionId
  /** The attempt that succeeded. */
  attempt_id: AttemptId
  /** The opaque outcome payload produced by the effect. */
  receipt: unknown
}

/** Payload inputs for {@link effectFailed}. */
export interface EffectFailedInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action that failed. */
  action_id: ActionId
  /** The attempt that failed. */
  attempt_id: AttemptId
  /** The stable machine-readable failure string. */
  error: string
}

/** Payload inputs for {@link effectCommitUnknown}. */
export interface EffectCommitUnknownInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action whose outcome is unknown. */
  action_id: ActionId
  /** The attempt whose outcome is unknown. */
  attempt_id: AttemptId
}

/** Payload inputs for {@link effectReconciled}. */
export interface EffectReconciledInput {
  /** The execution that requested the effect. */
  execution_id: ExecutionId
  /** The action that was reconciled. */
  action_id: ActionId
  /** The attempt that was reconciled. */
  attempt_id: AttemptId
  /** The recovered outcome payload. */
  receipt: unknown
}

/**
 * Build the durable payload for `execution/commanded`.
 * @param data - the execution, command string, and provenance.
 * @returns the versioned `execution/commanded` data payload.
 */
export function executionCommanded(data: ExecutionCommandedInput): DshControlPayload<'execution/commanded'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `activity/correlated`.
 * @param data - the execution, native event sequence, and kind tag.
 * @returns the versioned `activity/correlated` data payload.
 */
export function activityCorrelated(data: ActivityCorrelatedInput): DshControlPayload<'activity/correlated'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/requested`.
 * @param data - the execution, action, operation, resource, and authority class.
 * @returns the versioned `effect/requested` data payload.
 */
export function effectRequested(data: EffectRequestedInput): DshControlPayload<'effect/requested'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/authorized`.
 * @param data - the execution, action, and granting capability id.
 * @returns the versioned `effect/authorized` data payload.
 */
export function effectAuthorized(data: EffectAuthorizedInput): DshControlPayload<'effect/authorized'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/denied`.
 * @param data - the execution, action, and refusal reason.
 * @returns the versioned `effect/denied` data payload.
 */
export function effectDenied(data: EffectDeniedInput): DshControlPayload<'effect/denied'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/attempt-started`.
 * @param data - the execution, action, and fresh attempt id.
 * @returns the versioned `effect/attempt-started` data payload.
 */
export function effectAttemptStarted(data: EffectAttemptStartedInput): DshControlPayload<'effect/attempt-started'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/succeeded`.
 * @param data - the execution, action, attempt, and outcome receipt.
 * @returns the versioned `effect/succeeded` data payload.
 */
export function effectSucceeded(data: EffectSucceededInput): DshControlPayload<'effect/succeeded'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/failed`.
 * @param data - the execution, action, attempt, and failure string.
 * @returns the versioned `effect/failed` data payload.
 */
export function effectFailed(data: EffectFailedInput): DshControlPayload<'effect/failed'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/commit-unknown`.
 * @param data - the execution, action, and attempt whose outcome is unknown.
 * @returns the versioned `effect/commit-unknown` data payload.
 */
export function effectCommitUnknown(data: EffectCommitUnknownInput): DshControlPayload<'effect/commit-unknown'> {
  return { version: 1, ...data }
}

/**
 * Build the durable payload for `effect/reconciled`.
 * @param data - the execution, action, attempt, and recovered receipt.
 * @returns the versioned `effect/reconciled` data payload.
 */
export function effectReconciled(data: EffectReconciledInput): DshControlPayload<'effect/reconciled'> {
  return { version: 1, ...data }
}
