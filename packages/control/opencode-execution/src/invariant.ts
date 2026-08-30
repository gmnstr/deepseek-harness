/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-opencode-execution`.
 * @module @deepseek-ai/dsh-opencode-execution/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-opencode-execution'

/** Cordis companion plugin name. */
export const name = 'opencode-execution-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package derives read models purely from the DSH
 * session log and appends canonical control facts only through fenced DSH
 * persistence; every relationship it could observe (fold determinism, digest
 * sensitivity, fenced append rejection, epoch CAS, effect lifecycle order) is
 * owned by the persistence backend or the package's own projection/runtime
 * tests, so no continuously observable in-process relation is exposed here.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
