export type NodeKind =
  | 'interface'
  | 'type-alias'
  | 'function'
  | 'class'
  | 'const'
  | 'enum'
  | 'namespace'
  | 'property'
  | 'method'
  | 'parameter'
  | 'return-type'
  | 'type-parameter'

export type Position = 'input' | 'output' | 'invariant'

export type Visibility = 'public' | 'protected' | 'private'

export interface Modifiers {
  optional?: boolean
  readonly?: boolean
  abstract?: boolean
  visibility?: Visibility
  hasDefault?: boolean
  isRest?: boolean
}

export interface ApiNode {
  name: string
  path: string
  kind: NodeKind
  signature: string
  children: ApiNode[]
  typeId: string
  position: Position
  modifiers: Modifiers
  tags?: string[]
}

export interface ApiTree {
  packageName: string
  version: string
  entryPoint: string
  exports: ApiNode[]
}

export type ChangeKind = 'added' | 'removed' | 'changed'

export type SemverLevel = 'major' | 'minor' | 'patch'

/** Numeric ordering for severity comparisons: higher number = more severe. */
export const SEVERITY_ORDER: Record<SemverLevel, number> = {
  patch: 0,
  minor: 1,
  major: 2,
}

/** Ordered from most to least severe — used by formatters for display grouping. */
export const SEMVER_LEVELS: SemverLevel[] = ['major', 'minor', 'patch']

export interface ChangeDetails {
  /** For union changes: members that were added */
  addedMembers?: string[]
  /** For union changes: members that were removed */
  removedMembers?: string[]
  /** For union changes: members whose discriminant exists in both but shape changed */
  changedMembers?: string[]
}

export interface Change {
  kind: ChangeKind
  path: string
  semver: SemverLevel
  description: string
  reason?: string
  entryPoint?: string
  oldSignature?: string
  newSignature?: string
  /**
   * The raw API tree node from the old version. Used internally by the
   * classifier and compatibility checker. Structure may change in minor
   * versions — prefer `oldSignature` for display purposes.
   * @internal
   */
  oldNode?: ApiNode
  /**
   * The raw API tree node from the new version. Used internally by the
   * classifier and compatibility checker. Structure may change in minor
   * versions — prefer `newSignature` for display purposes.
   * @internal
   */
  newNode?: ApiNode
  details?: ChangeDetails
  /** The kind of the parent node (set for child-level changes like properties, params, type params) */
  parentKind?: NodeKind
}

export interface ChangeSet {
  packageName: string
  oldVersion: string
  newVersion: string
  changes: Change[]
  actualSemver: SemverLevel
  claimedSemver?: SemverLevel
  timings?: {
    resolveMs?: number
    extractMs?: number
    diffMs?: number
    totalMs?: number
  }
  /** Self-diagnostic warnings when the tool suspects output may be inaccurate. */
  diagnostics?: string[]
}

export interface TypediffOutput {
  schemaVersion: 1
  results: ChangeSet[]
}

export interface TypediffOptions {
  ignore?: string[]
  severity?: SemverLevel
  onProgress?: (message: string) => void
  onWarn?: (message: string) => void
  /** Callback for debug-level diagnostic messages (enabled via --debug). */
  onDebug?: (message: string) => void
  respectTags?: boolean
  /** Include underscore-prefixed internal members (default: false) */
  includeInternals?: boolean
  /** Custom npm registry URL (default: https://registry.npmjs.org) */
  registry?: string
}
