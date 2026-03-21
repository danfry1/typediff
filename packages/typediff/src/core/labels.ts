import type { NodeKind } from './types.js'

const KIND_NOUNS: Record<NodeKind, string> = {
  'interface': 'interface',
  'type-alias': 'type',
  'function': 'function',
  'class': 'class',
  'const': 'export',
  'enum': 'enum',
  'namespace': 'namespace',
  'property': 'property',
  'method': 'method',
  'parameter': 'parameter',
  'return-type': 'return type',
  'type-parameter': 'type parameter',
}

export function kindNoun(kind: NodeKind | string): string {
  return KIND_NOUNS[kind as NodeKind] ?? kind
}

export function addedLabel(kind: NodeKind | string): string {
  const noun = kindNoun(kind)
  return `New ${noun}`
}

export function removedLabel(kind: NodeKind | string): string {
  const noun = kindNoun(kind)
  return `Removed ${noun}`
}

export function changedLabel(kind: NodeKind | string): string {
  const noun = kindNoun(kind)
  return `Changed ${noun}`
}
