import type { ApiNode, ApiTree, Change, ChangeDetails, NodeKind } from './types.js'
import { addedLabel, removedLabel, changedLabel } from './labels.js'

export function diffApiTrees(oldTree: ApiTree, newTree: ApiTree): Change[] {
  return diffNodeLists(oldTree.exports, newTree.exports)
}

/** Generate a descriptive string for a removed export. */
function describeRemoved(node: ApiNode): string {
  return `${removedLabel(node.kind)} — consumers referencing this will break`
}

/** Generate a descriptive string for an added export. */
function describeAdded(node: ApiNode): string {
  return addedLabel(node.kind)
}

/** Generate a descriptive string for a changed export. */
function describeChanged(oldNode: ApiNode, newNode: ApiNode): string {
  const sig = newNode.signature ?? ''
  const oldSig = oldNode.signature ?? ''

  // Union type changes
  if (sig.includes(' | ') || oldSig.includes(' | ')) {
    const diff = computeUnionDiff(oldSig, sig)
    const hasAdded = diff?.addedMembers && diff.addedMembers.length > 0
    const hasRemoved = diff?.removedMembers && diff.removedMembers.length > 0
    const hasChanged = diff?.changedMembers && diff.changedMembers.length > 0
    if (oldNode.kind === 'type-alias' || newNode.kind === 'type-alias') {
      if (hasRemoved && !hasAdded && !hasChanged) {
        return `Union type narrowed — removed variants may cause type errors`
      }
      if (hasChanged && !hasAdded && !hasRemoved) {
        return `Union type variant(s) changed — may cause type errors`
      }
      if (hasChanged && (hasAdded || hasRemoved)) {
        return `Union type changed — variants added/removed and existing variants changed`
      }
      return `Union type widened — new variants may break exhaustive switches`
    }
    return `Union type changed`
  }

  // Required property changed (child level — both old and new exist)
  if (newNode.kind === 'property' && !newNode.modifiers.optional) {
    return `Required property changed — consumers using the old type will break`
  }

  // Added optional property (child level)
  if (newNode.kind === 'property' && newNode.modifiers.optional) {
    return `Added optional property`
  }

  return changedLabel(newNode.kind)
}

/**
 * Extract a discriminant value (kind or type field) from a union member string.
 * Only matches top-level fields (depth 1 inside the outer braces), not nested objects.
 */
function getDiscriminant(member: string): string | undefined {
  if (!member.startsWith('{')) return undefined
  // Extract only the top-level portion (depth 1) to avoid matching nested fields
  const topLevel = extractTopLevelContent(member)
  const kindMatch = topLevel.match(/kind:\s*("[^"]+"|'[^']+')/)
  if (kindMatch) return `kind: ${kindMatch[1]}`
  const typeMatch = topLevel.match(/type:\s*("[^"]+"|'[^']+')/)
  if (typeMatch) return `type: ${typeMatch[1]}`
  return undefined
}

/** Extract only the top-level fields from an object type string (strips nested objects). */
function extractTopLevelContent(member: string): string {
  let result = ''
  let depth = 0
  for (let i = 0; i < member.length; i++) {
    const ch = member[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string/template literal content at any depth to avoid
      // misinterpreting brackets inside strings (e.g., "a>b", `prefix-${string}`)
      if (depth === 1) result += ch
      i++
      while (i < member.length && member[i] !== ch) {
        if (member[i] === '\\') { if (depth === 1) result += member[i]; i++ } // skip escaped char
        if (depth === 1 && i < member.length) result += member[i]
        i++
      }
      if (depth === 1 && i < member.length) result += member[i]
    } else if (ch === '{' || ch === '<' || ch === '(' || ch === '[') {
      depth++
      if (depth === 1) continue // skip outer {
    } else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') {
      depth--
      if (depth === 0) break // stop at closing }
    } else if (depth === 1) {
      result += ch
    }
  }
  return result
}

/** Parse union members from a signature and compute added/removed/changed sets. */
function computeUnionDiff(oldSig: string, newSig: string): ChangeDetails | undefined {
  if (!oldSig.includes(' | ') && !newSig.includes(' | ')) return undefined

  const oldMembers = new Set(splitUnionMembers(oldSig))
  const newMembers = new Set(splitUnionMembers(newSig))

  const added = [...newMembers].filter(m => !oldMembers.has(m))
  const removed = [...oldMembers].filter(m => !newMembers.has(m))

  if (added.length === 0 && removed.length === 0) return undefined

  // Detect members with the same discriminant in both added and removed —
  // these are "changed" (e.g., { kind: "datetime" } with different fields)
  const changed: string[] = []
  const pureAdded: string[] = []
  const pureRemoved: string[] = []

  const removedByDiscriminant = new Map<string, string>()
  for (const m of removed) {
    const disc = getDiscriminant(m)
    if (disc) removedByDiscriminant.set(disc, m)
  }

  const matchedDiscriminants = new Set<string>()
  for (const m of added) {
    const disc = getDiscriminant(m)
    if (disc && removedByDiscriminant.has(disc)) {
      changed.push(summarizeUnionMember(m))
      matchedDiscriminants.add(disc)
    } else {
      pureAdded.push(summarizeUnionMember(m))
    }
  }

  for (const m of removed) {
    const disc = getDiscriminant(m)
    if (!disc || !matchedDiscriminants.has(disc)) {
      pureRemoved.push(summarizeUnionMember(m))
    }
  }

  return {
    addedMembers: pureAdded.length > 0 ? pureAdded : undefined,
    removedMembers: pureRemoved.length > 0 ? pureRemoved : undefined,
    changedMembers: changed.length > 0 ? changed : undefined,
  }
}

/**
 * Split a union type string into its top-level members, respecting
 * nested braces, angle brackets, and parentheses.
 * "A | { kind: 'x' | 'y' } | B" → ["A", "{ kind: 'x' | 'y' }", "B"]
 */
function splitUnionMembers(sig: string): string[] {
  const members: string[] = []
  let depth = 0
  let current = ''

  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string/template literal content at any depth to avoid misinterpreting
      // |, {, }, <, > inside strings (e.g., { kind: "List<string>" }, `prefix-${string}`)
      current += ch
      i++
      while (i < sig.length && sig[i] !== ch) {
        if (sig[i] === '\\') { current += sig[i++] } // skip escaped char
        if (i < sig.length) current += sig[i++]
      }
      if (i < sig.length) current += sig[i]
    } else if (ch === '{' || ch === '<' || ch === '(' || ch === '[') {
      depth++
      current += ch
    } else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') {
      depth--
      current += ch
    } else if (ch === '|' && depth === 0 && sig[i - 1] === ' ' && sig[i + 1] === ' ') {
      members.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }

  const last = current.trim()
  if (last) members.push(last)
  return members
}

/**
 * Summarize a union member for display. For complex object types like
 * { kind: "nanoid"; message?: string | undefined; }, extract just the
 * discriminant to show { kind: "nanoid" }.
 */
function summarizeUnionMember(member: string): string {
  // If it's a simple string/number literal or identifier, return as-is
  if (!member.startsWith('{')) return member

  // For object types, try to extract a top-level discriminant (usually `kind` or `type`)
  const topLevel = extractTopLevelContent(member)
  const kindMatch = topLevel.match(/kind:\s*("[^"]+"|'[^']+')/)
  if (kindMatch) return `{ kind: ${kindMatch[1]} }`

  const typeMatch = topLevel.match(/type:\s*("[^"]+"|'[^']+')/)
  if (typeMatch) return `{ type: ${typeMatch[1]} }`

  // Fallback: truncate at 40 chars
  if (member.length > 40) return member.slice(0, 37) + '...'
  return member
}

function modifiersChanged(oldNode: ApiNode, newNode: ApiNode): boolean {
  const a = oldNode.modifiers
  const b = newNode.modifiers
  return (
    a.optional !== b.optional ||
    a.readonly !== b.readonly ||
    a.abstract !== b.abstract ||
    a.visibility !== b.visibility ||
    a.hasDefault !== b.hasDefault ||
    a.isRest !== b.isRest
  )
}

function diffNodeLists(oldNodes: ApiNode[], newNodes: ApiNode[], parentKind?: NodeKind): Change[] {
  const oldMap = new Map<string, ApiNode>()
  for (const node of oldNodes) {
    oldMap.set(node.name, node)
  }

  const newMap = new Map<string, ApiNode>()
  for (const node of newNodes) {
    newMap.set(node.name, node)
  }

  const changes: Change[] = []

  // Removed nodes: in old but not in new
  for (const [name, oldNode] of oldMap) {
    if (!newMap.has(name)) {
      changes.push({
        kind: 'removed',
        path: oldNode.path,
        semver: 'major',
        description: describeRemoved(oldNode),
        oldSignature: oldNode.signature,
        oldNode,
        parentKind,
      })
    }
  }

  // Added nodes: in new but not in old
  for (const [name, newNode] of newMap) {
    if (!oldMap.has(name)) {
      changes.push({
        kind: 'added',
        path: newNode.path,
        semver: 'minor',
        description: describeAdded(newNode),
        newSignature: newNode.signature,
        newNode,
        parentKind,
      })
    }
  }

  // Matched nodes: same name in both
  for (const [name, oldNode] of oldMap) {
    const newNode = newMap.get(name)
    if (!newNode) continue

    // Fast path: identical typeId and identical modifiers means no change
    if (oldNode.typeId === newNode.typeId && !modifiersChanged(oldNode, newNode)) continue

    // Both have children: recurse into children
    if (oldNode.children.length > 0 || newNode.children.length > 0) {
      const childChanges = diffNodeLists(oldNode.children, newNode.children, oldNode.kind)
      changes.push(...childChanges)

      // Emit a parent-level change only for modifier changes (abstract, visibility, etc.)
      // that child diffs cannot represent. Signature changes on container types (interfaces,
      // classes) are fully explained by child-level property changes — emitting both would
      // inflate actualSemver with a redundant major on the parent.
      if (modifiersChanged(oldNode, newNode)) {
        changes.push({
          kind: 'changed',
          path: oldNode.path,
          semver: 'major',
          description: describeChanged(oldNode, newNode),
          oldSignature: oldNode.signature,
          newSignature: newNode.signature,
          oldNode,
          newNode,
          parentKind,
        })
      } else if (childChanges.length === 0 && oldNode.signature !== newNode.signature) {
        // No child changes but signature differs — the parent's own type changed
        // (e.g., type alias, generic constraint, extends clause with no child nodes)
        changes.push({
          kind: 'changed',
          path: oldNode.path,
          semver: 'major',
          description: describeChanged(oldNode, newNode),
          oldSignature: oldNode.signature,
          newSignature: newNode.signature,
          oldNode,
          newNode,
          parentKind,
          details: computeUnionDiff(oldNode.signature, newNode.signature),
        })
      }
    } else {
      // Leaf nodes with different typeId: changed
      changes.push({
        kind: 'changed',
        path: oldNode.path,
        semver: 'major',
        description: describeChanged(oldNode, newNode),
        oldSignature: oldNode.signature,
        newSignature: newNode.signature,
        oldNode,
        newNode,
        parentKind,
        details: computeUnionDiff(oldNode.signature, newNode.signature),
      })
    }
  }

  return changes
}
