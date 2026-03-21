import semver from 'semver'
import { SEVERITY_ORDER, type ApiNode, type Change, type SemverLevel } from './types.js'

function maxSemver(a: SemverLevel, b: SemverLevel): SemverLevel {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b
}

function markMajor(change: Change, reason?: string): 'major' {
  change.reason = reason
  return 'major'
}

/**
 * Classify a single change as major, minor, or patch.
 *
 * Conservative approach: any type signature change is considered major,
 * since we cannot yet determine if changes are widening or narrowing.
 */
export function classifyChange(
  change: Change,
  oldNode?: ApiNode,
  newNode?: ApiNode,
): SemverLevel {
  if (change.kind === 'removed') {
    return markMajor(change)
  }

  if (change.kind === 'added') {
    if (newNode) {
      const isPropertyOrParam =
        newNode.kind === 'property' || newNode.kind === 'parameter' || newNode.kind === 'type-parameter'
      const isRequired =
        !newNode.modifiers.optional && !newNode.modifiers.hasDefault

      if (isPropertyOrParam && isRequired) {
        // Adding a required property to an output-only type is non-breaking:
        // the library provides it, consumers just read it.
        // But adding to input/invariant types is breaking: consumers must
        // now supply/implement the new property.
        if (newNode.position === 'output') {
          return 'minor'
        }
        if (newNode.kind === 'type-parameter') {
          // Adding a type parameter to a function/method/class is non-breaking —
          // TypeScript infers type parameters at call sites.
          // Adding to an interface/type-alias IS breaking — consumers must provide it.
          // Functions/methods/consts: TS infers type params at call sites → safe
          // Classes excluded: `let x: MyClass` and `extends MyClass` require explicit type args
          const funcLike: string[] = ['function', 'method', 'const']
          if (change.parentKind && funcLike.includes(change.parentKind)) {
            return 'minor'
          }
          return markMajor(change)
        }
        if (newNode.kind === 'parameter') {
          // Rest parameters don't break existing callers — they collect
          // additional arguments that weren't previously accepted.
          if (newNode.modifiers.isRest) return 'minor'
          return markMajor(change)
        }
        return markMajor(change)
      }
    }
    return 'minor'
  }

  // change.kind === 'changed'
  if (oldNode && newNode) {
    // Readonly changes
    const wasReadonly = oldNode.modifiers.readonly ?? false
    const isReadonly = newNode.modifiers.readonly ?? false
    if (!wasReadonly && isReadonly) {
      return markMajor(change, 'Making this readonly breaks code that assigns to it')
    }
    if (wasReadonly && !isReadonly) {
      // Only downgrade to minor if the type signature itself didn't change.
      // If both readonly was removed AND the type changed (e.g., readonly x: string → x: number),
      // fall through to position-based classification since the type change may be breaking.
      if (oldNode.typeId === newNode.typeId) {
        return 'minor' // removing readonly grants write access
      }
    }

    // Abstract removal: removing abstract is additive — consumers gain the ability
    // to instantiate the class. Adding abstract is breaking.
    const wasAbstract = oldNode.modifiers.abstract ?? false
    const isAbstract = newNode.modifiers.abstract ?? false
    if (!wasAbstract && isAbstract) {
      return markMajor(change, 'Making this abstract breaks code that instantiates it')
    }
    if (wasAbstract && !isAbstract) {
      if (oldNode.typeId === newNode.typeId) {
        return 'minor' // removing abstract is additive
      }
    }

    // Visibility relaxation: protected → public is non-breaking
    const oldVis = oldNode.modifiers.visibility
    const newVis = newNode.modifiers.visibility
    if (oldVis === 'protected' && (newVis === 'public' || newVis === undefined)) {
      if (oldNode.typeId === newNode.typeId) {
        return 'minor' // relaxing visibility is additive
      }
    }
    if ((oldVis === 'public' || oldVis === undefined) && newVis === 'protected') {
      return markMajor(change, 'Restricting visibility breaks code that accesses this member')
    }

    // Optionality change: required → optional is relaxing, but only if the type didn't also change.
    // x: string → x?: string is minor (relaxing), but x: string → x?: number is breaking.
    const wasOptional = oldNode.modifiers.optional ?? false
    const isOptional = newNode.modifiers.optional ?? false
    if (!wasOptional && isOptional) {
      if (oldNode.typeId === newNode.typeId) {
        return 'minor'
      }
      // Type also changed — fall through to position-based classification
    }
    if (wasOptional && !isOptional) {
      return markMajor(change, 'Making this required breaks code that omits it')
    }

    // Position-based classification (conservative: all type changes are major)
    const position = newNode.position ?? oldNode.position
    if (position === 'invariant') {
      return markMajor(change)
    }
    if (position === 'output') {
      return markMajor(change, 'Return type widened — consumers may get unexpected values')
    }
    if (position === 'input') {
      return markMajor(change, 'Input type narrowed — some existing values will be rejected')
    }
  }

  // Default: conservative
  return markMajor(change)
}

/**
 * Classify an array of changes, returning the highest severity level.
 */
export function classifyChanges(changes: Change[]): { actualSemver: SemverLevel } {
  if (changes.length === 0) {
    return { actualSemver: 'patch' }
  }

  let result: SemverLevel = 'patch'
  for (const change of changes) {
    if (!change.semver) {
      const level = classifyChange(change, change.oldNode, change.newNode)
      change.semver = level
    }
    result = maxSemver(result, change.semver)
  }
  return { actualSemver: result }
}

/**
 * Derive the claimed semver level from a version bump.
 *
 * Handles 0.x conventions:
 * - 0.0.x → any bump is major (unstable)
 * - 0.x.y → minor bump is major, patch bump is minor
 * - Pre-release with same base version → patch
 */
export function deriveClaimedSemver(
  oldVersion: string,
  newVersion: string,
): SemverLevel {
  const oldParsed = semver.parse(oldVersion)
  const newParsed = semver.parse(newVersion)

  if (!oldParsed || !newParsed) {
    return 'major' // unknown → assume worst case
  }

  // Pre-release: if same major.minor.patch, treat as patch
  if (
    oldParsed.major === newParsed.major &&
    oldParsed.minor === newParsed.minor &&
    oldParsed.patch === newParsed.patch &&
    (oldParsed.prerelease.length > 0 || newParsed.prerelease.length > 0)
  ) {
    return 'patch'
  }

  // 0.0.x → everything is potentially breaking
  if (oldParsed.major === 0 && oldParsed.minor === 0) {
    return 'major'
  }

  // 0.x → minor bump = breaking, patch bump = features
  if (oldParsed.major === 0) {
    if (newParsed.minor !== oldParsed.minor) {
      return 'major'
    }
    return 'minor'
  }

  // Standard semver (>= 1.0.0)
  if (newParsed.major !== oldParsed.major) {
    return 'major'
  }
  if (newParsed.minor !== oldParsed.minor) {
    return 'minor'
  }
  return 'patch'
}

/**
 * Refine semver classification based on JSDoc/TSDoc tags.
 *
 * When --respect-tags is enabled, breaking changes to @internal/@alpha exports
 * are downgraded to patch, @beta to minor, and @deprecated removals to minor.
 */
export function applyTagRefinement(changes: Change[]): void {
  for (const change of changes) {
    if (change.semver !== 'major') continue
    const oldTags = change.oldNode?.tags ?? []
    if (oldTags.includes('internal') || oldTags.includes('alpha')) {
      const tag = oldTags.includes('internal') ? '@internal' : '@alpha'
      change.semver = 'patch'
      change.reason = `Downgraded from major — marked ${tag}`
    } else if (oldTags.includes('beta')) {
      change.semver = 'minor'
      change.reason = 'Downgraded from major — marked @beta'
    } else if (oldTags.includes('deprecated') && change.kind === 'removed') {
      change.semver = 'minor'
      change.reason = 'Downgraded from major — marked @deprecated'
    }
  }
}
