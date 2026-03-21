// Primary API — stable across minor versions
export type {
  ApiNode,
  ApiTree,
  Change,
  ChangeDetails,
  ChangeSet,
  TypediffOutput,
  TypediffOptions,
  SemverLevel,
  ChangeKind,
  NodeKind,
  Position,
  Modifiers,
} from './core/types.js'
export { SEVERITY_ORDER, SEMVER_LEVELS } from './core/types.js'

// Re-export commonly used building blocks for convenience
// Full set available via 'typediff/advanced'
export { extractApiTree } from './core/extractor.js'
export { diffApiTrees } from './core/differ.js'
export { classifyChange, classifyChanges, deriveClaimedSemver } from './core/classifier.js'
export { checkCompatibility } from './core/compatibility.js'
export { createSnapshot, loadSnapshot } from './core/snapshot.js'
export type { ApiSnapshot } from './core/snapshot.js'

import type { Change, ChangeSet, TypediffOptions } from './core/types.js'
import { extractApiTree, createSharedProgram, extractApiTreeFromProgram } from './core/extractor.js'
import { diffApiTrees } from './core/differ.js'
import { classifyChange, deriveClaimedSemver, applyTagRefinement } from './core/classifier.js'
import { resolveMultiEntry, type MultiEntryResult } from './resolver/local.js'
import { resolveNpm } from './resolver/npm.js'
import { refineWithCompatibility, aggregateSemver, applyFilters } from './core/refine.js'

/**
 * Shared multi-entry diff loop used by diff(), diffLocal(), and diffMixed().
 * Iterates entry points, extracts API trees, diffs them, classifies changes,
 * runs compatibility refinement, and handles added/removed entry points.
 */
function diffMultiEntry(
  oldMulti: MultiEntryResult,
  newMulti: MultiEntryResult,
  options?: TypediffOptions,
): Change[] {
  const allChanges: Change[] = []
  const onWarn = options?.onWarn
  const onDebug = options?.onDebug

  onDebug?.(`Old package: ${oldMulti.packageName}@${oldMulti.version} (${oldMulti.entries.length} entry points)`)
  onDebug?.(`New package: ${newMulti.packageName}@${newMulti.version} (${newMulti.entries.length} entry points)`)

  // Create shared TS programs — one per package version, covering ALL entry points.
  // This avoids creating one ts.createProgram() per entry point (critical for
  // packages like date-fns with 598 entry points: 1196 programs → 2 programs).
  const allOldFiles = oldMulti.entries.map((e) => e.typesPath)
  const allNewFiles = newMulti.entries.map((e) => e.typesPath)
  const oldProgram = createSharedProgram(allOldFiles)
  const newProgram = createSharedProgram(allNewFiles)

  options?.onProgress?.('Comparing types...')
  // For each entry point in the new package, try to find a matching one in the old package
  for (const newEntry of newMulti.entries) {
    const oldEntry = oldMulti.entries.find((e) => e.entryPoint === newEntry.entryPoint)

    if (!oldEntry) {
      // Entire entry point was added — extract all exports as "added"
      const newTree = extractApiTreeFromProgram(newProgram, newEntry.typesPath, {
        packageName: newMulti.packageName,
        version: newMulti.version,
        entryPoint: newEntry.entryPoint,
        onWarn,
      })
      const emptyTree = {
        packageName: oldMulti.packageName,
        version: oldMulti.version,
        entryPoint: newEntry.entryPoint,
        exports: [],
      }
      const changes = diffApiTrees(emptyTree, newTree)
      for (const change of changes) {
        change.semver = classifyChange(change, change.oldNode, change.newNode)
        if (newEntry.entryPoint !== '.') {
          change.path = `${newEntry.entryPoint}:${change.path}`
        }
        change.entryPoint = newEntry.entryPoint === '.' ? undefined : newEntry.entryPoint
      }
      allChanges.push(...changes)
      continue
    }

    const oldTree = extractApiTreeFromProgram(oldProgram, oldEntry.typesPath, {
      packageName: oldMulti.packageName,
      version: oldMulti.version,
      entryPoint: oldEntry.entryPoint,
      onWarn,
    })
    const newTree = extractApiTreeFromProgram(newProgram, newEntry.typesPath, {
      packageName: newMulti.packageName,
      version: newMulti.version,
      entryPoint: newEntry.entryPoint,
      onWarn,
    })

    const changes = diffApiTrees(oldTree, newTree)
    onDebug?.(`Entry ${newEntry.entryPoint}: ${oldTree.exports.length} old exports, ${newTree.exports.length} new exports, ${changes.length} raw changes`)
    for (const change of changes) {
      change.semver = classifyChange(change, change.oldNode, change.newNode)
    }

    const hasChangedExports = changes.some((c) => c.kind === 'changed')
    if (hasChangedExports) {
      // Safety check: paths must NOT be entry-point-prefixed before refinement,
      // because refineWithCompatibility uses change.path.split('.')[0] to extract
      // the top-level export name for the compatibility checker.
      if (newEntry.entryPoint !== '.' && changes.some((c) => c.path.startsWith(newEntry.entryPoint + ':'))) {
        throw new Error(
          `Internal error: change paths were prefixed before compatibility refinement. ` +
          `This is a bug in typediff — please report it.`,
        )
      }
      const changedCount = changes.filter((c) => c.kind === 'changed').length
      onDebug?.(`Running compatibility refinement on ${changedCount} changed exports...`)
      options?.onProgress?.('Checking compatibility...')
      refineWithCompatibility(changes, oldEntry.typesPath, newEntry.typesPath, onWarn)
      const downgraded = changes.filter((c) => c.kind === 'changed' && c.semver !== 'major').length
      onDebug?.(`Compatibility refinement: ${downgraded}/${changedCount} changes downgraded from major`)
    }

    // Prefix paths AFTER refinement so change.path.split('.')[0] works correctly
    for (const change of changes) {
      if (newEntry.entryPoint !== '.') {
        change.path = `${newEntry.entryPoint}:${change.path}`
      }
      change.entryPoint = newEntry.entryPoint === '.' ? undefined : newEntry.entryPoint
    }
    allChanges.push(...changes)
  }

  // Check for removed entry points
  for (const oldEntry of oldMulti.entries) {
    const stillExists = newMulti.entries.find((e) => e.entryPoint === oldEntry.entryPoint)
    if (!stillExists) {
      const oldTree = extractApiTreeFromProgram(oldProgram, oldEntry.typesPath, {
        packageName: oldMulti.packageName,
        version: oldMulti.version,
        entryPoint: oldEntry.entryPoint,
        onWarn,
      })
      const emptyTree = {
        packageName: newMulti.packageName,
        version: newMulti.version,
        entryPoint: oldEntry.entryPoint,
        exports: [],
      }
      const changes = diffApiTrees(oldTree, emptyTree)
      for (const change of changes) {
        change.semver = classifyChange(change, change.oldNode, change.newNode)
        if (oldEntry.entryPoint !== '.') {
          change.path = `${oldEntry.entryPoint}:${change.path}`
        }
        change.entryPoint = oldEntry.entryPoint === '.' ? undefined : oldEntry.entryPoint
      }
      allChanges.push(...changes)
    }
  }

  return allChanges
}

export async function diffLocal(
  oldPath: string,
  newPath: string,
  options?: TypediffOptions,
): Promise<ChangeSet> {
  const t0 = performance.now()
  options?.onProgress?.('Extracting API surface...')
  const oldMulti = resolveMultiEntry(oldPath)
  const newMulti = resolveMultiEntry(newPath)
  const tExtract = performance.now()

  let allChanges = diffMultiEntry(oldMulti, newMulti, options)
  const tDiff = performance.now()

  if (options?.respectTags) {
    applyTagRefinement(allChanges)
  }

  allChanges = applyFilters(allChanges, options)

  const actualSemver = aggregateSemver(allChanges)
  const claimedSemver = deriveClaimedSemver(oldMulti.version, newMulti.version)

  return {
    packageName: newMulti.packageName,
    oldVersion: oldMulti.version,
    newVersion: newMulti.version,
    changes: allChanges,
    actualSemver,
    claimedSemver,
    timings: {
      extractMs: Math.round(tExtract - t0),
      diffMs: Math.round(tDiff - tExtract),
      totalMs: Math.round(performance.now() - t0),
    },
  }
}

export async function diff(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  options?: TypediffOptions,
): Promise<ChangeSet> {
  const t0 = performance.now()
  options?.onProgress?.('Fetching...')
  const npmOptions = options?.registry ? { registry: options.registry } : undefined
  const [oldResolved, newResolved] = await Promise.all([
    resolveNpm(packageName, oldVersion, npmOptions),
    resolveNpm(packageName, newVersion, npmOptions),
  ])
  const tResolve = performance.now()

  options?.onProgress?.('Extracting API surface...')
  const oldMulti = resolveMultiEntry(oldResolved.packageDir)
  const newMulti = resolveMultiEntry(newResolved.packageDir)
  const tExtract = performance.now()

  let allChanges = diffMultiEntry(oldMulti, newMulti, options)
  const tDiff = performance.now()

  if (options?.respectTags) {
    applyTagRefinement(allChanges)
  }

  allChanges = applyFilters(allChanges, options)

  const actualSemver = aggregateSemver(allChanges)
  const claimedSemver = deriveClaimedSemver(oldVersion, newVersion)

  return {
    packageName,
    oldVersion,
    newVersion,
    changes: allChanges,
    actualSemver,
    claimedSemver,
    timings: {
      resolveMs: Math.round(tResolve - t0),
      extractMs: Math.round(tExtract - tResolve),
      diffMs: Math.round(tDiff - tExtract),
      totalMs: Math.round(performance.now() - t0),
    },
  }
}

export async function diffMixed(
  localPath: string,
  npmPackage: string,
  npmVersion: string,
  localIsOld: boolean,
  options?: TypediffOptions,
): Promise<ChangeSet> {
  const t0 = performance.now()
  options?.onProgress?.(`Fetching ${npmPackage}@${npmVersion}...`)
  const npmResolved = await resolveNpm(npmPackage, npmVersion, options?.registry ? { registry: options.registry } : undefined)

  options?.onProgress?.('Resolving local package...')
  const localMulti = resolveMultiEntry(localPath)
  const npmMulti = resolveMultiEntry(npmResolved.packageDir)
  const tResolve = performance.now()

  const oldMulti = localIsOld ? localMulti : npmMulti
  const newMulti = localIsOld ? npmMulti : localMulti

  options?.onProgress?.('Extracting API surface...')
  let allChanges = diffMultiEntry(oldMulti, newMulti, options)
  const tDiff = performance.now()

  if (options?.respectTags) {
    applyTagRefinement(allChanges)
  }

  allChanges = applyFilters(allChanges, options)

  const actualSemver = aggregateSemver(allChanges)
  const oldVersion = localIsOld ? localMulti.version : npmVersion
  const newVersion = localIsOld ? npmVersion : localMulti.version
  const claimedSemver = deriveClaimedSemver(oldVersion, newVersion)

  return {
    packageName: npmPackage,
    oldVersion,
    newVersion,
    changes: allChanges,
    actualSemver,
    claimedSemver,
    timings: {
      resolveMs: Math.round(tResolve - t0),
      diffMs: Math.round(tDiff - tResolve),
      totalMs: Math.round(performance.now() - t0),
    },
  }
}
