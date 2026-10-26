import { minimatch } from 'minimatch'
import { SEVERITY_ORDER, type Change, type SemverLevel, type TypediffOptions } from './types.js'
import { checkCompatibilityTargets, type CompatTarget, type CompatibilityResult } from './compatibility.js'

/**
 * Map a (bare, not-yet-entry-prefixed) change path to the depth-2 member whose
 * type should be compatibility-checked. A change deeper than the member (e.g. a
 * method parameter `Class.method.param`) maps to its containing member
 * (`Class.method`), since checking the member's whole type covers any change
 * within it. Synthetic member names ([call], [new], return, Symbol/index
 * members) return null so the change falls back to its export's result.
 */
function parseMemberTarget(
  path: string,
): { id: string; exportName: string; memberName: string; isStatic: boolean } | null {
  const parts = path.split('.')
  if (parts.length < 2) return null
  const exportName = parts[0]
  const segment = parts[1]
  let memberName = segment
  let isStatic = false
  const STATIC_PREFIX = 'static '
  if (memberName.startsWith(STATIC_PREFIX)) {
    isStatic = true
    memberName = memberName.slice(STATIC_PREFIX.length)
  }
  if (memberName.startsWith('[') || memberName === 'return') return null
  // Key by the depth-2 member so multiple changes under one member share a target.
  return { id: `m:${exportName}.${segment}`, exportName, memberName, isStatic }
}

export function refineWithCompatibility(
  changes: Change[],
  oldDtsPath: string,
  newDtsPath: string,
  onWarn?: (msg: string) => void,
): void {
  const changed = changes.filter((c) => c.kind === 'changed' && c.oldNode && c.newNode)
  if (changed.length === 0) return

  // Top-level exports that have changed children — the coarse fallback target.
  const exportNames = [...new Set(changed.map((c) => c.path.split('.')[0]))]

  // Per-member targets: each changed member is checked on its own, so a
  // backwards-compatible member is not held breaking just because a sibling of
  // its containing export changed in a breaking way.
  const memberIdByChange = new Map<Change, string>()
  const memberTargets = new Map<string, CompatTarget>()
  for (const c of changed) {
    const m = parseMemberTarget(c.path)
    if (!m) continue
    memberIdByChange.set(c, m.id)
    if (!memberTargets.has(m.id)) {
      memberTargets.set(m.id, { id: m.id, exportName: m.exportName, member: { name: m.memberName, isStatic: m.isStatic } })
    }
  }

  const targets: CompatTarget[] = [
    ...exportNames.map((name) => ({ id: `e:${name}`, exportName: name })),
    ...memberTargets.values(),
  ]

  let compat: Map<string, CompatibilityResult>
  try {
    compat = checkCompatibilityTargets(oldDtsPath, newDtsPath, targets)
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

    // Prefer the precise per-member verdict; fall back to the containing export.
    const memberId = memberIdByChange.get(change)
    const result = (memberId ? compat.get(memberId) : undefined) ?? compat.get(`e:${change.path.split('.')[0]}`)
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
