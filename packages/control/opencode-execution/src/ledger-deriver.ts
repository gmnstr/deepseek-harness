/**
 * The demoted-write-path audit surface. This module REPLACES the old
 * `ExecutionLedger` authority (integration/execution-contract/ledger.ts): all
 * canonical control facts now live in the DSH session log, and this module
 * derives read models only. There is no independent authoritative write API —
 * any call that would mutate derived state directly from runtime memory is
 * forbidden; derived writes only follow DSH events.
 *
 * @module @deepseek-ai/dsh-opencode-execution/ledger-deriver
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { DerivedSessionState } from './types.ts'
import { foldProjection } from './projection.ts'

/**
 * Load the canonical DSH log for a session — the read surface that replaces
 * the old `ExecutionLedger.readEvents`.
 * @param persistence - the fenced session persistence backend.
 * @param sessionId - the session whose canonical log is loaded.
 * @returns the validated immutable header and contiguous logical event log.
 */
export async function readFromDsh(
  persistence: SessionPersistence,
  sessionId: SessionId,
): Promise<SessionInspection> {
  return persistence.load(sessionId)
}

/**
 * Derive the complete read model for a session from its canonical DSH log
 * alone. The derived state is a pure function of the log: after a crash a
 * fresh runtime loads the persisted DSH log and rebuilds the same projection.
 * @param persistence - the fenced session persistence backend.
 * @param sessionId - the session whose projection is derived.
 * @returns the derived execution/activity/authority/effect state with digest.
 */
export async function deriveAll(
  persistence: SessionPersistence,
  sessionId: SessionId,
): Promise<DerivedSessionState> {
  const inspection = await readFromDsh(persistence, sessionId)
  return foldProjection(inspection.events, String(sessionId))
}
