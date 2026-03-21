import { resolve as resolvePath } from 'node:path'
import { resolveLocal, type ResolveResult } from './local.js'
import { resolveNpm } from './npm.js'
import { parseSpec, isLocalPath } from '../cli/utils.js'

export type { ResolveResult, MultiEntryResult } from './local.js'
export { resolveLocal, resolveMultiEntry } from './local.js'
export { resolveNpm, getPreviousVersion, getLatestVersion } from './npm.js'

/**
 * Resolve a specifier to a types entry point.
 *
 * Specifier formats:
 * - `./path` or `/abs/path` — local directory
 * - `pkg@version` — npm package
 * - `@scope/pkg@version` — scoped npm package (last `@` is the separator)
 */
export async function resolve(specifier: string): Promise<ResolveResult> {
  if (isLocalPath(specifier)) {
    const dir = resolvePath(specifier)
    return resolveLocal(dir)
  }

  const parsed = parseSpec(specifier)
  if (!parsed) {
    throw new Error(
      `Invalid specifier "${specifier}". Expected format: pkg@version`,
    )
  }
  return resolveNpm(parsed.name, parsed.version)
}
