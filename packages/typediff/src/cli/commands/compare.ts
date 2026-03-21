import type { ChangeSet, TypediffOptions, Change } from '../../core/types.js'
import { loadSnapshot, snapshotToApiTrees, synthesizeDtsFromTree } from '../../core/snapshot.js'
import { createSharedProgram, extractApiTreeFromProgram } from '../../core/extractor.js'
import { diffApiTrees } from '../../core/differ.js'
import { classifyChange, applyTagRefinement } from '../../core/classifier.js'
import { aggregateSemver, applyFilters, refineWithCompatibility } from '../../core/refine.js'
import { resolveMultiEntry } from '../../resolver/local.js'
import { resolveNpm } from '../../resolver/npm.js'
import { parseSpec, isLocalPath } from '../utils.js'

export async function runCompare(
  snapshotPath: string,
  targetSpec: string,
  options: TypediffOptions,
): Promise<ChangeSet> {
  const snapshot = loadSnapshot(snapshotPath, (msg) => console.error(`  Warning: ${msg}`))
  const oldTrees = snapshotToApiTrees(snapshot)

  // Resolve new side
  let newEntryPoints: Map<string, { typesPath: string }>
  let resolvedNewVersion = 'local'

  if (isLocalPath(targetSpec)) {
    const multi = resolveMultiEntry(targetSpec)
    newEntryPoints = new Map(multi.entries.map(e => [e.entryPoint, { typesPath: e.typesPath }]))
    resolvedNewVersion = multi.version  // from package.json
  } else {
    const parsed = parseSpec(targetSpec)
    if (!parsed) {
      throw new Error(`Invalid package spec "${targetSpec}". Expected format: pkg@version`)
    }
    resolvedNewVersion = parsed.version
    const resolved = await resolveNpm(parsed.name, parsed.version, options.registry ? { registry: options.registry } : undefined)
    const multi = resolveMultiEntry(resolved.packageDir)
    newEntryPoints = new Map(multi.entries.map(e => [e.entryPoint, { typesPath: e.typesPath }]))
  }

  // Create a shared program for all new entry points (avoids one ts.createProgram per entry)
  const newFilePaths = [...newEntryPoints.values()].map(e => e.typesPath)
  const sharedProgram = newFilePaths.length > 0 ? createSharedProgram(newFilePaths) : null

  // Diff each entry point
  let allChanges: Change[] = []
  const allEntryPoints = new Set([...oldTrees.keys(), ...newEntryPoints.keys()])

  for (const ep of allEntryPoints) {
    const oldTree = oldTrees.get(ep)
    const newEntry = newEntryPoints.get(ep)

    if (!oldTree && newEntry) {
      // New entry point added
      const newTree = extractApiTreeFromProgram(sharedProgram!, newEntry.typesPath, {
        packageName: snapshot.packageName,
        version: 'new',
        entryPoint: newEntry.typesPath,
        onWarn: options.onWarn,
      })
      const emptyTree = { packageName: snapshot.packageName, version: snapshot.packageVersion, entryPoint: ep, exports: [] }
      const changes = diffApiTrees(emptyTree, newTree)
      for (const change of changes) {
        change.semver = classifyChange(change, change.oldNode, change.newNode)
        if (ep !== '.') change.path = `${ep}:${change.path}`
        change.entryPoint = ep === '.' ? undefined : ep
      }
      allChanges.push(...changes)
    } else if (oldTree && !newEntry) {
      // Entry point removed
      const emptyTree = { packageName: snapshot.packageName, version: 'new', entryPoint: ep, exports: [] }
      const changes = diffApiTrees(oldTree, emptyTree)
      for (const change of changes) {
        change.semver = classifyChange(change, change.oldNode, change.newNode)
        if (ep !== '.') change.path = `${ep}:${change.path}`
        change.entryPoint = ep === '.' ? undefined : ep
      }
      allChanges.push(...changes)
    } else if (oldTree && newEntry) {
      // Both exist — diff normally
      const newTree = extractApiTreeFromProgram(sharedProgram!, newEntry.typesPath, {
        packageName: snapshot.packageName,
        version: 'new',
        entryPoint: newEntry.typesPath,
        onWarn: options.onWarn,
      })
      const changes = diffApiTrees(oldTree, newTree)
      for (const change of changes) {
        change.semver = classifyChange(change, change.oldNode, change.newNode)
      }

      // Synthesize a .d.ts from the snapshot's ApiTree so we can run
      // compatibility refinement (previously skipped for snapshots).
      const hasChangedExports = changes.some((c) => c.kind === 'changed')
      if (hasChangedExports) {
        let synth: ReturnType<typeof synthesizeDtsFromTree> | undefined
        try {
          synth = synthesizeDtsFromTree(oldTree)
          refineWithCompatibility(changes, synth.dtsPath, newEntry.typesPath, options.onWarn)
        } catch (err) {
          const detail = err instanceof Error ? `: ${err.message}` : ''
          options.onWarn?.(`Compatibility refinement failed for snapshot comparison${detail} — results may over-report breaking changes.`)
        } finally {
          synth?.cleanup()
        }
      }

      for (const change of changes) {
        if (ep !== '.') change.path = `${ep}:${change.path}`
        change.entryPoint = ep === '.' ? undefined : ep
      }
      allChanges.push(...changes)
    }
  }

  // Apply tag refinement if enabled
  if (options.respectTags) {
    applyTagRefinement(allChanges)
  }

  allChanges = applyFilters(allChanges, options)
  const actualSemver = aggregateSemver(allChanges)

  return {
    packageName: snapshot.packageName,
    oldVersion: snapshot.packageVersion,
    newVersion: resolvedNewVersion,
    changes: allChanges,
    actualSemver,
    claimedSemver: undefined,
  }
}
