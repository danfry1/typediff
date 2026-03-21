import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import type { ApiNode, Change, SemverLevel } from '../core/types.js'
import { classifyChange, classifyChanges, deriveClaimedSemver, applyTagRefinement } from '../core/classifier.js'
import { diffLocal } from '../index.js'

function makeChange(overrides: Partial<Change> & { kind: Change['kind'] }): Change {
  return { path: 'test', semver: 'patch', description: 'test', ...overrides }
}

function makeNode(overrides: Partial<ApiNode>): ApiNode {
  return {
    name: 'test',
    path: 'test',
    kind: 'property',
    signature: 'string',
    children: [],
    typeId: 'abc',
    position: 'output',
    modifiers: {},
    ...overrides,
  }
}

describe('classifyChange', () => {
  it('export removed → major', () => {
    const change = makeChange({ kind: 'removed' })
    expect(classifyChange(change)).toBe('major')
  })

  it('export added (new top-level) → minor', () => {
    const change = makeChange({ kind: 'added' })
    expect(classifyChange(change)).toBe('minor')
  })

  it('required property added to invariant interface → major', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'property', position: 'invariant', modifiers: { optional: false } })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  it('required property added to input interface → major', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'property', position: 'input', modifiers: { optional: false } })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  it('required property added to output type → minor (non-breaking for consumers)', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'property', position: 'output', modifiers: { optional: false } })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  it('optional property added → minor', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'property', modifiers: { optional: true } })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  it('required function parameter added to invariant position → major', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'parameter', position: 'invariant', modifiers: { optional: false } })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  it('required function parameter added to output position → minor', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'parameter', position: 'output', modifiers: { optional: false } })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  it('function parameter made optional (old not optional, new optional) → minor', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'parameter', modifiers: { optional: false } })
    const newNode = makeNode({ kind: 'parameter', modifiers: { optional: true } })
    expect(classifyChange(change, oldNode, newNode)).toBe('minor')
  })

  it('property made optional with type change → major (not minor)', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'property', position: 'input', modifiers: { optional: false }, typeId: 'old-id' })
    const newNode = makeNode({ kind: 'property', position: 'input', modifiers: { optional: true }, typeId: 'new-id' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('type change in invariant position → major', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ position: 'invariant', signature: 'string' })
    const newNode = makeNode({ position: 'invariant', signature: 'number' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('type change in output position → major', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ position: 'output', signature: 'string' })
    const newNode = makeNode({ position: 'output', signature: 'number' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('type change in input position → major', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ position: 'input', signature: 'string' })
    const newNode = makeNode({ position: 'input', signature: 'number' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('readonly added to mutable property → major', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ modifiers: { readonly: false } })
    const newNode = makeNode({ modifiers: { readonly: true } })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('readonly removed (type unchanged) → minor', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ modifiers: { readonly: true }, typeId: 'same' })
    const newNode = makeNode({ modifiers: { readonly: false }, typeId: 'same' })
    expect(classifyChange(change, oldNode, newNode)).toBe('minor')
  })

  it('readonly removed AND type changed → major (not short-circuited to minor)', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ modifiers: { readonly: true }, typeId: 'aaa', position: 'invariant', signature: 'string' })
    const newNode = makeNode({ modifiers: { readonly: false }, typeId: 'bbb', position: 'invariant', signature: 'number' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('rest parameter added → minor (non-breaking for existing callers)', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'parameter', position: 'input', modifiers: { isRest: true } })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  it('making optional property required → major', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'property', position: 'invariant', modifiers: { optional: true } })
    const newNode = makeNode({ kind: 'property', position: 'invariant', modifiers: { optional: false } })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('making optional property required includes reason about optionality', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'property', position: 'output', modifiers: { optional: true }, typeId: 'same' })
    const newNode = makeNode({ kind: 'property', position: 'output', modifiers: { optional: false }, typeId: 'same' })
    classifyChange(change, oldNode, newNode)
    expect(change.reason).toContain('required')
  })

  it('defaults to major for changed with no nodes (conservative fallback)', () => {
    const change = makeChange({ kind: 'changed' })
    expect(classifyChange(change, undefined, undefined)).toBe('major')
  })

  it('abstract added → major (breaks instantiation)', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'class', position: 'invariant', modifiers: { abstract: false }, typeId: 'same' })
    const newNode = makeNode({ kind: 'class', position: 'invariant', modifiers: { abstract: true }, typeId: 'same' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('abstract removed (type unchanged) → minor (additive)', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'class', position: 'invariant', modifiers: { abstract: true }, typeId: 'same' })
    const newNode = makeNode({ kind: 'class', position: 'invariant', modifiers: { abstract: false }, typeId: 'same' })
    expect(classifyChange(change, oldNode, newNode)).toBe('minor')
  })

  it('abstract removed AND type changed → major', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'class', position: 'invariant', modifiers: { abstract: true }, typeId: 'aaa' })
    const newNode = makeNode({ kind: 'class', position: 'invariant', modifiers: { abstract: false }, typeId: 'bbb' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('visibility relaxed protected → public (type unchanged) → minor', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'method', position: 'invariant', modifiers: { visibility: 'protected' }, typeId: 'same' })
    const newNode = makeNode({ kind: 'method', position: 'invariant', modifiers: { visibility: 'public' }, typeId: 'same' })
    expect(classifyChange(change, oldNode, newNode)).toBe('minor')
  })

  it('visibility restricted public → protected → major', () => {
    const change = makeChange({ kind: 'changed' })
    const oldNode = makeNode({ kind: 'method', position: 'invariant', modifiers: { visibility: 'public' }, typeId: 'same' })
    const newNode = makeNode({ kind: 'method', position: 'invariant', modifiers: { visibility: 'protected' }, typeId: 'same' })
    expect(classifyChange(change, oldNode, newNode)).toBe('major')
  })

  it('@deprecated changed (not removed) stays major', () => {
    const changes: Change[] = [{
      kind: 'changed', path: 'deprecatedFn', semver: 'major', description: 'Changed',
      oldNode: makeNode({ name: 'deprecatedFn', tags: ['deprecated'] }),
      newNode: makeNode({ name: 'deprecatedFn' }),
    }]
    applyTagRefinement(changes)
    expect(changes[0].semver).toBe('major')
  })

  it('enum member removed → major', () => {
    const change = makeChange({ kind: 'removed' })
    const oldNode = makeNode({ kind: 'const' })
    expect(classifyChange(change, oldNode)).toBe('major')
  })

  it('enum member added → minor', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'const' })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })
})

describe('type-parameter classification', () => {
  it('classifies added type parameter with default as minor', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({
      kind: 'type-parameter',
      position: 'input',
      modifiers: { hasDefault: true },
    })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  // parentKind-aware: adding type params to functions is always minor (TS infers them)
  it('classifies added type parameter on function as minor', () => {
    const change = makeChange({ kind: 'added', parentKind: 'function' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  it('classifies added type parameter on method as minor', () => {
    const change = makeChange({ kind: 'added', parentKind: 'method' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  it('classifies added type parameter on class as major (used as type annotation)', () => {
    const change = makeChange({ kind: 'added', parentKind: 'class' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  it('classifies added type parameter on const (function-typed) as minor', () => {
    const change = makeChange({ kind: 'added', parentKind: 'const' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })

  // Adding type params to types/interfaces IS breaking — consumers must provide them
  it('classifies added type parameter on interface as major', () => {
    const change = makeChange({ kind: 'added', parentKind: 'interface' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  it('classifies added type parameter on type-alias as major', () => {
    const change = makeChange({ kind: 'added', parentKind: 'type-alias' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  it('classifies added type parameter on namespace as major', () => {
    const change = makeChange({ kind: 'added', parentKind: 'namespace' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  it('classifies added type parameter with no parentKind as major (conservative)', () => {
    const change = makeChange({ kind: 'added' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: {} })
    expect(classifyChange(change, undefined, newNode)).toBe('major')
  })

  // Type param with default is always minor regardless of parent
  it('classifies added type parameter with default on interface as minor', () => {
    const change = makeChange({ kind: 'added', parentKind: 'interface' })
    const newNode = makeNode({ kind: 'type-parameter', position: 'input', modifiers: { hasDefault: true } })
    expect(classifyChange(change, undefined, newNode)).toBe('minor')
  })
})

describe('deriveClaimedSemver', () => {
  it('1.0.0 → 2.0.0 = major', () => {
    expect(deriveClaimedSemver('1.0.0', '2.0.0')).toBe('major')
  })

  it('1.0.0 → 1.1.0 = minor', () => {
    expect(deriveClaimedSemver('1.0.0', '1.1.0')).toBe('minor')
  })

  it('1.0.0 → 1.0.1 = patch', () => {
    expect(deriveClaimedSemver('1.0.0', '1.0.1')).toBe('patch')
  })

  it('0.1.0 → 0.2.0 = major (0.x minor = breaking)', () => {
    expect(deriveClaimedSemver('0.1.0', '0.2.0')).toBe('major')
  })

  it('0.1.0 → 0.1.1 = minor (0.x patch = features)', () => {
    expect(deriveClaimedSemver('0.1.0', '0.1.1')).toBe('minor')
  })

  it('0.0.1 → 0.0.2 = major (0.0.x = anything goes)', () => {
    expect(deriveClaimedSemver('0.0.1', '0.0.2')).toBe('major')
  })

  it('1.0.0-beta.1 → 1.0.0-beta.2 = patch (pre-release)', () => {
    expect(deriveClaimedSemver('1.0.0-beta.1', '1.0.0-beta.2')).toBe('patch')
  })

  it('1.0.0 → 3.0.0 = major (multi-component jump)', () => {
    expect(deriveClaimedSemver('1.0.0', '3.0.0')).toBe('major')
  })

  it('returns major for unparseable old version', () => {
    expect(deriveClaimedSemver('workspace:*', '1.0.0')).toBe('major')
  })

  it('returns major for empty version strings', () => {
    expect(deriveClaimedSemver('', '1.0.0')).toBe('major')
  })

  it('returns major when both versions are unparseable', () => {
    expect(deriveClaimedSemver('latest', 'next')).toBe('major')
  })
})

describe('classifyChanges', () => {
  it('mixed changes → highest severity wins as actualSemver', () => {
    const changes: Change[] = [
      makeChange({ kind: 'added', semver: 'minor' }),
      makeChange({ kind: 'removed', semver: 'major' }),
      makeChange({ kind: 'changed', semver: 'patch' }),
    ]
    const result = classifyChanges(changes)
    expect(result.actualSemver).toBe('major')
  })

  it('empty array → patch', () => {
    const result = classifyChanges([])
    expect(result.actualSemver).toBe('patch')
  })
})

describe('applyTagRefinement', () => {
  it('downgrades @internal removal from major to patch with reason', () => {
    const changes: Change[] = [{
      kind: 'removed', path: 'internalFn', semver: 'major', description: 'Removed',
      oldNode: makeNode({ name: 'internalFn', tags: ['internal'] }),
    }]
    applyTagRefinement(changes)
    expect(changes[0].semver).toBe('patch')
    expect(changes[0].reason).toContain('@internal')
  })

  it('downgrades @beta change from major to minor with reason', () => {
    const changes: Change[] = [{
      kind: 'changed', path: 'betaFn', semver: 'major', description: 'Changed',
      oldNode: makeNode({ name: 'betaFn', tags: ['beta'] }),
      newNode: makeNode({ name: 'betaFn' }),
    }]
    applyTagRefinement(changes)
    expect(changes[0].semver).toBe('minor')
    expect(changes[0].reason).toContain('@beta')
  })

  it('downgrades @alpha change from major to patch with reason', () => {
    const changes: Change[] = [{
      kind: 'changed', path: 'alphaFn', semver: 'major', description: 'Changed',
      oldNode: makeNode({ name: 'alphaFn', tags: ['alpha'] }),
      newNode: makeNode({ name: 'alphaFn' }),
    }]
    applyTagRefinement(changes)
    expect(changes[0].semver).toBe('patch')
    expect(changes[0].reason).toContain('@alpha')
  })

  it('does not downgrade @public changes', () => {
    const changes: Change[] = [{
      kind: 'removed', path: 'publicFn', semver: 'major', description: 'Removed',
      oldNode: makeNode({ name: 'publicFn', tags: ['public'] }),
    }]
    applyTagRefinement(changes)
    expect(changes[0].semver).toBe('major')
  })

  it('downgrades @deprecated removal from major to minor with reason', () => {
    const changes: Change[] = [{
      kind: 'removed', path: 'deprecatedFn', semver: 'major', description: 'Removed',
      oldNode: makeNode({ name: 'deprecatedFn', tags: ['deprecated'] }),
    }]
    applyTagRefinement(changes)
    expect(changes[0].semver).toBe('minor')
    expect(changes[0].reason).toContain('@deprecated')
  })
})

describe('breaking change reasons', () => {
  it('omits reason for removed export (description is sufficient)', () => {
    const change: Change = { kind: 'removed', path: 'foo', semver: 'patch', description: '' }
    classifyChange(change, makeNode({ name: 'foo' }), undefined)
    expect(change.reason).toBeUndefined()
  })

  it('omits reason for added required parameter', () => {
    const change: Change = { kind: 'added', path: 'foo.bar', semver: 'patch', description: '' }
    const newNode = makeNode({ name: 'bar', kind: 'parameter', position: 'input' })
    classifyChange(change, undefined, newNode)
    expect(change.reason).toBeUndefined()
  })

  it('omits reason for added required type parameter', () => {
    const change: Change = { kind: 'added', path: 'foo.T', semver: 'patch', description: '' }
    const newNode = makeNode({ name: 'T', kind: 'type-parameter', position: 'input' })
    classifyChange(change, undefined, newNode)
    expect(change.reason).toBeUndefined()
  })

  it('omits reason for added required property', () => {
    const change: Change = { kind: 'added', path: 'foo.prop', semver: 'patch', description: '' }
    const newNode = makeNode({ name: 'prop', kind: 'property', position: 'input' })
    classifyChange(change, undefined, newNode)
    expect(change.reason).toBeUndefined()
  })

  it('adds reason for making readonly', () => {
    const change: Change = { kind: 'changed', path: 'foo.prop', semver: 'patch', description: '' }
    const oldNode = makeNode({ modifiers: { readonly: false } })
    const newNode = makeNode({ modifiers: { readonly: true } })
    classifyChange(change, oldNode, newNode)
    expect(change.reason).toContain('readonly')
  })

  it('omits reason for invariant position change', () => {
    const change: Change = { kind: 'changed', path: 'foo', semver: 'patch', description: '' }
    const oldNode = makeNode({ position: 'invariant', signature: 'string' })
    const newNode = makeNode({ position: 'invariant', signature: 'number' })
    classifyChange(change, oldNode, newNode)
    expect(change.reason).toBeUndefined()
  })

  it('adds reason for output position change', () => {
    const change: Change = { kind: 'changed', path: 'foo', semver: 'patch', description: '' }
    const oldNode = makeNode({ position: 'output', signature: 'string' })
    const newNode = makeNode({ position: 'output', signature: 'number' })
    classifyChange(change, oldNode, newNode)
    expect(change.reason).toContain('Return type widened')
  })

  it('adds reason for input position change', () => {
    const change: Change = { kind: 'changed', path: 'foo', semver: 'patch', description: '' }
    const oldNode = makeNode({ position: 'input', signature: 'string' })
    const newNode = makeNode({ position: 'input', signature: 'number' })
    classifyChange(change, oldNode, newNode)
    expect(change.reason).toContain('Input type narrowed')
  })

  it('sets downgrade reason when tag refinement downgrades to patch', () => {
    const change: Change = {
      kind: 'removed', path: 'internalFn', semver: 'major', description: 'Removed',
      reason: 'Removing this export breaks any code that imports it',
      oldNode: makeNode({ name: 'internalFn', tags: ['internal'] }),
    }
    applyTagRefinement([change])
    expect(change.semver).toBe('patch')
    expect(change.reason).toContain('@internal')
  })

  it('does not set reason for non-breaking changes', () => {
    const change: Change = { kind: 'added', path: 'foo', semver: 'patch', description: '' }
    classifyChange(change, undefined, makeNode({ kind: 'function' }))
    expect(change.reason).toBeUndefined()
  })
})

it('respects tags when option is set', async () => {
  const result = await diffLocal(
    resolve(__dirname, 'fixtures/tsdoc-tags/old'),
    resolve(__dirname, 'fixtures/tsdoc-tags/new'),
    { respectTags: true },
  )
  // internalApi removal should be patch (not major) because it was @internal
  // betaApi removal should be minor (not major) because it was @beta
  const internal = result.changes.find(c => c.path === 'internalApi')
  const beta = result.changes.find(c => c.path === 'betaApi')
  expect(internal).toBeDefined()
  expect(internal!.semver).not.toBe('major')
  expect(beta).toBeDefined()
  expect(beta!.semver).toBe('minor')
})
