import type { ApiNode, ApiTree, Change, Impact, ImpactTier } from './types.js'

/**
 * TS keywords, primitives, and common lib.d.ts globals that must never be
 * treated as references to a package export. Identifier matching is approximate
 * by design — impact only ranks changes, it never gates the semver verdict — but
 * filtering these removes the bulk of false edges cheaply.
 */
const NON_REFERENCES = new Set([
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'null',
  'undefined', 'object', 'symbol', 'bigint', 'this', 'true', 'false',
  'readonly', 'keyof', 'typeof', 'infer', 'extends', 'in', 'is', 'asserts',
  'new', 'function', 'type', 'const', 'enum', 'interface', 'class', 'export',
  'import', 'default', 'as', 'satisfies', 'abstract', 'get', 'set',
  'Promise', 'Array', 'ReadonlyArray', 'Record', 'Partial', 'Required',
  'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'Parameters',
  'ReturnType', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp',
  'Error', 'Iterable', 'Iterator', 'Awaited', 'Uppercase', 'Lowercase',
])

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g

/**
 * Tier thresholds. Centrality is measured per entry point, so the *ratio*
 * (share of the module's other exports) is unreliable for small modules — a
 * 2-export entry trivially yields ratio 1.0 from a single reference. So absolute
 * reach is the primary signal; the ratio only gates top-level borderline cases.
 * Tuned against zod / drizzle-orm real-package diffs; re-validate before changing.
 */
/** A symbol referenced by at least this many other exports is high impact outright. */
const HIGH_REACH_ABS = 8
/** A top-level symbol needs at least this many dependents to qualify as high via the ratio path. */
const TOP_LEVEL_HIGH_MIN_REACH = 3
/** ...and this share of the module's other exports. */
const TOP_LEVEL_HIGH_MIN_RATIO = 0.15
/** A deeply-nested symbol referenced by at most this many exports is low impact. */
const DEEP_LOW_MAX_REACH = 1

/** Full type text of an export = its own signature plus every descendant signature. */
function fullSignatureText(node: ApiNode): string {
  let text = node.signature
  for (const child of node.children) {
    text += '\n' + fullSignatureText(child)
  }
  return text
}

/**
 * Remove text that can carry identifiers which are NOT type references, so the
 * tokenizer doesn't create phantom edges:
 *  - string and template literals: `type T = 'active' | 'inactive'` must not
 *    edge to an export named `active`. (`${...}` interiors are preserved, since
 *    template-literal types can interpolate real type references.)
 *  - line and block comments.
 *
 * Implemented as a single O(n) pass rather than regexes: the input is a type
 * signature from the analyzed package (untrusted), and a backtracking regex over
 * it is a denial-of-service vector.
 */
function stripNonReferenceText(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2 // skip the closing */ (harmless if past end)
      out += ' '
    } else if (c === '/' && next === '/') {
      i += 2
      while (i < n && text[i] !== '\n') i++
      out += ' '
    } else if (c === "'" || c === '"') {
      i++
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') i++ // skip the escaped character
        i++
      }
      i++ // skip the closing quote
      out += ' '
    } else if (c === '`') {
      i++
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '$' && text[i + 1] === '{') {
          // Preserve interpolation — it can hold real type references.
          out += '${'
          i += 2
          let depth = 1
          while (i < n && depth > 0) {
            if (text[i] === '{') depth++
            else if (text[i] === '}') depth--
            if (depth > 0) out += text[i]
            i++
          }
          out += '}'
          continue
        }
        i++ // drop the literal character
      }
      i++ // skip the closing backtick
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Names a type declares as its own generic parameters — references to these are
 *  local, not edges to package exports. Best-effort: reads the first `<...>` group. */
function ownTypeParameters(signature: string): Set<string> {
  const params = new Set<string>()
  const open = signature.indexOf('<')
  if (open === -1) return params
  // Walk to the matching '>' so we only capture the declaration's own parameter list.
  let depth = 0
  let end = -1
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === '<') depth++
    else if (signature[i] === '>') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return params
  const inner = signature.slice(open + 1, end)
  // A parameter name is the leading identifier of each top-level comma segment.
  let segDepth = 0
  let seg = ''
  const segments: string[] = []
  for (const ch of inner) {
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') segDepth++
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') segDepth--
    if (ch === ',' && segDepth === 0) { segments.push(seg); seg = '' } else seg += ch
  }
  segments.push(seg)
  for (const s of segments) {
    const m = s.trim().match(/^[A-Za-z_$][A-Za-z0-9_$]*/)
    if (m) params.add(m[0])
  }
  return params
}

/**
 * Forward reference graph over TOP-LEVEL exports.
 * An edge A → B means A's public type surface mentions B. Edges only point at
 * known package exports, so unrelated identifiers (locals, lib globals) drop out.
 *
 * This reads the serializable {@link ApiTree}, so it works on snapshots as well
 * as live diffs. For collision-free precision a checker-based variant could
 * resolve identifiers to symbols during extraction; the verdict never depends on
 * this graph, so the approximate form is acceptable as the portable default.
 */
function buildReferenceGraph(tree: ApiTree): Map<string, Set<string>> {
  const exportNames = new Set(tree.exports.map((e) => e.name))
  const graph = new Map<string, Set<string>>()

  for (const exp of tree.exports) {
    const refs = new Set<string>()
    const text = stripNonReferenceText(fullSignatureText(exp))
    const typeParams = ownTypeParameters(exp.signature)
    for (const match of text.matchAll(IDENT)) {
      const id = match[0]
      if (id === exp.name) continue
      if (NON_REFERENCES.has(id)) continue
      if (typeParams.has(id)) continue
      if (exportNames.has(id)) refs.add(id)
    }
    graph.set(exp.name, refs)
  }
  return graph
}

/** Reverse a forward graph: B → {A | A references B}. */
function reverseGraph(graph: Map<string, Set<string>>): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>()
  for (const [from, tos] of graph) {
    for (const to of tos) {
      let parents = reverse.get(to)
      if (!parents) {
        parents = new Set<string>()
        reverse.set(to, parents)
      }
      parents.add(from)
    }
  }
  return reverse
}

/**
 * Centrality of `target` = number of distinct top-level exports that
 * transitively reference it (reverse reachability). Cycle-guarded, since
 * interfaces and types routinely reference one another.
 */
function computeCentrality(target: string, reverse: Map<string, Set<string>>): number {
  const ancestors = new Set<string>()
  const queue = [...(reverse.get(target) ?? [])]
  while (queue.length > 0) {
    const node = queue.pop()!
    // A reference cycle can lead back to the target itself — don't let a symbol
    // count as referencing itself.
    if (node === target || ancestors.has(node)) continue
    ancestors.add(node)
    for (const parent of reverse.get(node) ?? []) {
      queue.push(parent)
    }
  }
  return ancestors.size
}

/** Strip the `entryPoint:` prefix a path carries for non-root entry points. */
function bareApiPath(change: Change): string {
  return change.entryPoint ? change.path.replace(/^[^:]+:/, '') : change.path
}

/** The top-level export a change lives under (graph nodes are keyed by these). */
function topLevelExportOf(change: Change): string {
  return bareApiPath(change).split('.')[0]
}

function prominenceOf(change: Change): Impact['prominence'] {
  const depth = bareApiPath(change).split('.').length
  if (depth === 1) return 'top-level'
  if (depth === 2) return 'nested'
  return 'deep'
}

function classifyTier(reach: number, ratio: number, prominence: Impact['prominence']): ImpactTier {
  // Deep, rarely-referenced members (e.g. objectUtil.addQuestionMarks.R) → low.
  if (prominence === 'deep' && reach <= DEEP_LOW_MAX_REACH) return 'low'
  // Many dependents within the module → high, regardless of where the symbol sits.
  if (reach >= HIGH_REACH_ABS) return 'high'
  // A prominent symbol a meaningful share of a non-trivial module depends on → high.
  if (prominence === 'top-level' && reach >= TOP_LEVEL_HIGH_MIN_REACH && ratio >= TOP_LEVEL_HIGH_MIN_RATIO) {
    return 'high'
  }
  return 'medium'
}

/**
 * Annotate the changes for ONE entry point with impact scores, mutating
 * `change.impact` in place. Patch-level changes are skipped (ranking only
 * matters for breaking/feature changes). The semver verdict is never touched —
 * impact is a display signal only.
 *
 * Call this while `newTree` is in scope and BEFORE change paths are prefixed
 * with the entry point, or after — `bareApiPath` handles either form.
 */
export function annotateImpact(changes: Change[], newTree: ApiTree): void {
  if (newTree.exports.length === 0) return

  const graph = buildReferenceGraph(newTree)
  const reverse = reverseGraph(graph)
  const otherExports = Math.max(newTree.exports.length - 1, 1)
  const centralityCache = new Map<string, number>()

  for (const change of changes) {
    if (change.semver === 'patch') continue

    const root = topLevelExportOf(change)
    let referencedBy = centralityCache.get(root)
    if (referencedBy === undefined) {
      referencedBy = computeCentrality(root, reverse)
      centralityCache.set(root, referencedBy)
    }

    const centralityRatio = referencedBy / otherExports
    const prominence = prominenceOf(change)
    change.impact = {
      tier: classifyTier(referencedBy, centralityRatio, prominence),
      referencedByPublicExports: referencedBy,
      centralityRatio,
      prominence,
    }
  }
}
