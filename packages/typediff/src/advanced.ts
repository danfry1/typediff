/**
 * Advanced building blocks for power users.
 *
 * These exports provide low-level access to typediff's internals
 * for custom diffing pipelines. The main `typediff` entry point
 * is recommended for most use cases.
 *
 * @remarks
 * This subpath (`typediff/advanced`) has a less stable API than
 * the main entry point. Breaking changes here may occur in minor
 * versions.
 */

// Extraction
export type { ExtractOptions } from './core/extractor.js'
export { extractApiTree, createSharedProgram, extractApiTreeFromProgram } from './core/extractor.js'

// Diffing
export { diffApiTrees } from './core/differ.js'

// Classification
export { classifyChange, classifyChanges, deriveClaimedSemver, applyTagRefinement } from './core/classifier.js'

// Compatibility
export { checkCompatibility } from './core/compatibility.js'

// Resolution
export { resolveLocal, resolveMultiEntry, resolveLocalAuto } from './resolver/local.js'
export type { MultiEntryResult, LocalAutoResult } from './resolver/local.js'
export { resolveNpm, getPreviousVersion, getLatestVersion } from './resolver/npm.js'
export type { NpmResolveOptions } from './resolver/npm.js'

// Refinement
export { refineWithCompatibility, aggregateSemver, applyFilters } from './core/refine.js'

// Snapshots
export { createSnapshot, loadSnapshot, snapshotToApiTrees } from './core/snapshot.js'
export type { ApiSnapshot } from './core/snapshot.js'

// Constants
export { SEVERITY_ORDER, SEMVER_LEVELS } from './core/types.js'
