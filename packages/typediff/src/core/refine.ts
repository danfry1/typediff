import { minimatch } from 'minimatch'
import { SEVERITY_ORDER, type Change, type SemverLevel, type TypediffOptions } from './types.js'
import { checkCompatibility } from './compatibility.js'

export function refineWithCompatibility(
  changes: Change[],
  oldDtsPath: string,
  newDtsPath: string,
  onWarn?: (msg: string) => void,
): void {
  const changedExports = [
    ...new Set(
      changes
        .filter((c) => c.kind === 'changed' && c.oldNode && c.newNode)
        .map((c) => c.path.split('.')[0]),
    ),
  ]

  if (changedExports.length === 0) return

  let compat: Map<string, { newAssignableToOld: boolean; oldAssignableToNew: boolean }>
  try {
    compat = checkCompatibility(oldDtsPath, newDtsPath, changedExports)
  } catch (err) {
    // If compatibility checking fails (e.g., TS compiler error on unusual types),
    // leave all changes at their original severity (conservative — no false downgrades)
    const detail = err instanceof Error ? `: ${err.message}` : ''
    onWarn?.(`Compatibility refinement failed${detail} — results may over-report breaking changes`)
    return
  }

  for (const change of changes) {
    // Only refine 'changed' changes — added/removed changes have their own
    // classification that should not be overwritten by parent-level compatibility
    if (change.kind !== 'changed') continue

    const topLevelName = change.path.split('.')[0]
    const result = compat.get(topLevelName)
    if (!result) continue

    if (result.newAssignableToOld && result.oldAssignableToNew) {
      change.semver = 'patch'
      change.reason = undefined
      change.description = `Type representation changed but remains structurally equivalent`
    } else if (result.newAssignableToOld) {
      // One-way assignability: new can be used where old was expected.
      // This is only safe to downgrade for output-position types (consumers only read them).
      // For invariant/input types, consumers may also produce values of this type,
      // so narrowing is breaking.
      const position = change.newNode?.position ?? change.oldNode?.position
      if (position === 'output' && SEVERITY_ORDER[change.semver] > SEVERITY_ORDER['minor']) {
        change.semver = 'minor'
        change.reason = undefined
        change.description = `Backwards-compatible change in ${change.path}`
      }
    }
  }
}

export function aggregateSemver(changes: Change[]): SemverLevel {
  if (changes.length === 0) return 'patch'
  let result: SemverLevel = 'patch'
  for (const change of changes) {
    if (SEVERITY_ORDER[change.semver] > SEVERITY_ORDER[result]) {
      result = change.semver
    }
  }
  return result
}

export function applyFilters(changes: Change[], options?: TypediffOptions): Change[] {
  let filtered = changes

  // Filter underscore-prefixed internal members by default
  if (!options?.includeInternals) {
    filtered = filtered.filter((c) => {
      // Strip entry-point prefix (e.g. "./utils:ExportName" → "ExportName")
      const pathWithoutEntry = c.path.includes(':') ? c.path.split(':').slice(1).join(':') : c.path
      const segments = pathWithoutEntry.split('.')
      return !segments.some((s) => s.startsWith('_'))
    })
  }

  if (options?.ignore && options.ignore.length > 0) {
    filtered = filtered.filter(
      (c) => !options.ignore!.some((pattern) => minimatch(c.path, pattern)),
    )
  }
  if (options?.severity) {
    const minLevel = SEVERITY_ORDER[options.severity]
    filtered = filtered.filter((c) => SEVERITY_ORDER[c.semver] >= minLevel)
  }
  return filtered
}
