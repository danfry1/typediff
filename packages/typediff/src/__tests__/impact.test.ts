import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import type { ApiNode, ApiTree, Change } from '../core/types.js'
import { annotateImpact } from '../core/impact.js'
import { diffLocal } from '../index.js'

const fixturesDir = join(import.meta.dirname, 'fixtures')

function node(overrides: Partial<ApiNode> & { name: string }): ApiNode {
  return {
    path: overrides.name,
    kind: 'interface',
    signature: '',
    children: [],
    typeId: 'id',
    position: 'invariant',
    modifiers: {},
    ...overrides,
  }
}

function tree(exports: ApiNode[]): ApiTree {
  return { packageName: 'p', version: '1.0.0', entryPoint: '.', exports }
}

function change(overrides: Partial<Change> & { path: string }): Change {
  return { kind: 'changed', semver: 'major', description: '', ...overrides }
}

describe('annotateImpact', () => {
  it('scores a widely-referenced top-level export as high impact', () => {
    // Core is referenced by A, B, C → maximally central in a 4-export tree.
    const t = tree([
      node({ name: 'Core', signature: 'interface Core { v: string }' }),
      node({ name: 'A', signature: 'interface A { c: Core }' }),
      node({ name: 'B', signature: 'interface B { c: Core }' }),
      node({ name: 'C', signature: 'interface C { c: Core }' }),
    ])
    const changes = [change({ path: 'Core' })]
    annotateImpact(changes, t)

    expect(changes[0].impact?.tier).toBe('high')
    expect(changes[0].impact?.referencedByPublicExports).toBe(3)
    expect(changes[0].impact?.prominence).toBe('top-level')
  })

  it('scores a deep, rarely-referenced member as low impact', () => {
    // objectUtil is referenced by nothing else; the change is 3 levels deep.
    const t = tree([
      node({ name: 'objectUtil', signature: 'declare const objectUtil: { addQuestionMarks: { R: unknown } }' }),
      node({ name: 'A', signature: 'interface A { v: string }' }),
      node({ name: 'B', signature: 'interface B { v: string }' }),
      node({ name: 'C', signature: 'interface C { v: string }' }),
    ])
    const changes = [change({ path: 'objectUtil.addQuestionMarks.R' })]
    annotateImpact(changes, t)

    expect(changes[0].impact?.tier).toBe('low')
    expect(changes[0].impact?.referencedByPublicExports).toBe(0)
    expect(changes[0].impact?.prominence).toBe('deep')
  })

  it('counts transitive references (A → B → Core)', () => {
    const t = tree([
      node({ name: 'Core', signature: 'interface Core { v: string }' }),
      node({ name: 'B', signature: 'interface B { c: Core }' }),
      node({ name: 'A', signature: 'interface A { b: B }' }),
    ])
    const changes = [change({ path: 'Core' })]
    annotateImpact(changes, t)
    // Both A (transitively) and B (directly) reach Core.
    expect(changes[0].impact?.referencedByPublicExports).toBe(2)
  })

  it('is cycle-safe when types reference each other', () => {
    const t = tree([
      node({ name: 'X', signature: 'interface X { y: Y }' }),
      node({ name: 'Y', signature: 'interface Y { x: X }' }),
    ])
    const changes = [change({ path: 'X' })]
    expect(() => annotateImpact(changes, t)).not.toThrow()
    expect(changes[0].impact?.referencedByPublicExports).toBe(1)
  })

  it('skips patch-level changes', () => {
    const t = tree([node({ name: 'A', signature: 'interface A {}' })])
    const changes = [change({ path: 'A', semver: 'patch' })]
    annotateImpact(changes, t)
    expect(changes[0].impact).toBeUndefined()
  })

  it('never mutates the semver verdict', () => {
    const t = tree([node({ name: 'A', signature: 'interface A {}' })])
    const changes = [change({ path: 'A', semver: 'major' })]
    annotateImpact(changes, t)
    expect(changes[0].semver).toBe('major')
  })

  it('resolves bare paths under an entry-point prefix', () => {
    const t = tree([
      node({ name: 'Core', signature: 'interface Core { v: string }' }),
      node({ name: 'A', signature: 'interface A { c: Core }' }),
    ])
    const changes = [change({ path: 'utils:Core', entryPoint: 'utils' })]
    annotateImpact(changes, t)
    expect(changes[0].impact?.referencedByPublicExports).toBe(1)
  })

  it('does nothing for an empty tree', () => {
    const changes = [change({ path: 'A' })]
    annotateImpact(changes, tree([]))
    expect(changes[0].impact).toBeUndefined()
  })

  it('does not edge to an export name appearing inside a string-literal type', () => {
    // `active` is both an export and a literal in Mode's union — it must not
    // count as Mode referencing the `active` export.
    const t = tree([
      node({ name: 'active', signature: 'interface active { v: string }' }),
      node({ name: 'Mode', signature: "type Mode = 'active' | 'inactive'" }),
      node({ name: 'Other', signature: 'interface Other { v: string }' }),
    ])
    const changes = [change({ path: 'active' })]
    annotateImpact(changes, t)
    expect(changes[0].impact?.referencedByPublicExports).toBe(0)
  })

  it('does not edge through identifiers inside comments', () => {
    const t = tree([
      node({ name: 'Core', signature: 'interface Core { v: string }' }),
      node({ name: 'A', signature: 'interface A { /* uses Core elsewhere */ v: string }' }),
    ])
    const changes = [change({ path: 'Core' })]
    annotateImpact(changes, t)
    expect(changes[0].impact?.referencedByPublicExports).toBe(0)
  })

  it('does not treat a type’s own generic parameter as a reference', () => {
    // `Item` is Box's type parameter here, not the exported `Item`.
    const t = tree([
      node({ name: 'Item', signature: 'interface Item { id: string }' }),
      node({ name: 'Box', signature: 'interface Box<Item> { value: Item }' }),
    ])
    const changes = [change({ path: 'Item' })]
    annotateImpact(changes, t)
    expect(changes[0].impact?.referencedByPublicExports).toBe(0)
  })

  it('still counts a real reference that shares a name with a generic param elsewhere', () => {
    // Box<T> uses T (local), but Holder genuinely references the Item export.
    const t = tree([
      node({ name: 'Item', signature: 'interface Item { id: string }' }),
      node({ name: 'Box', signature: 'interface Box<T> { value: T }' }),
      node({ name: 'Holder', signature: 'interface Holder { item: Item }' }),
    ])
    const changes = [change({ path: 'Item' })]
    annotateImpact(changes, t)
    expect(changes[0].impact?.referencedByPublicExports).toBe(1)
  })

  it('populates impact end-to-end through diffLocal', async () => {
    const result = await diffLocal(
      join(fixturesDir, 'impact-ranking/old'),
      join(fixturesDir, 'impact-ranking/new'),
    )
    // Widening the Status union is breaking, and Status is referenced by three
    // other exports (User, Account, currentStatus) → high impact.
    const statusChange = result.changes.find((c) => c.path === 'Status')
    expect(statusChange?.semver).toBe('major')
    expect(statusChange?.impact?.tier).toBe('high')
    expect(statusChange?.impact?.referencedByPublicExports).toBe(3)
    expect(statusChange?.impact?.prominence).toBe('top-level')
  })
})
