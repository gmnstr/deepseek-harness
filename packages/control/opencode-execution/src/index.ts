/**
 * Derived-projection execution runtime for the DeepSeek Harness session log.
 * This package REPLACES the old `ExecutionLedger` authority: all canonical
 * control facts live in the DSH session log, and this package derives read
 * models only. The runtime writes control facts canonically through fenced
 * DSH persistence (`appendFenced` + the A1 control-event vocabulary) and owns
 * NO independent authoritative write API.
 *
 * @module @deepseek-ai/dsh-opencode-execution
 */

export { CapabilityKernel, AuthorityError, resourceMatches } from './capability.ts'
export type { Capability, EffectProposal, AuthorizationDecision } from './capability.ts'
export {
  ControlTransitionError,
  ExecutionRuntime,
  SessionOwnershipFencedError,
} from './execution-runtime.ts'
export type { ControlAppend, ExecutionRuntimeOptions } from './execution-runtime.ts'
export { EffectExecutor } from './effect-executor.ts'
export type {
  EffectExecOutcome,
  EffectOutcome,
  EffectResult,
  EffectWorker,
  OutboxRecord,
} from './effect-executor.ts'
export { foldProjection } from './projection.ts'
export { deriveAll, readFromDsh } from './ledger-deriver.ts'
export type * from './types.ts'
