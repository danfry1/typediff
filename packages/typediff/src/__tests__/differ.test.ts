import { describe, it, expect } from 'vitest'
import type { ApiNode, ApiTree } from '../core/types.js'
import { diffApiTrees } from '../core/differ.js'

function makeNode(overrides: Partial<ApiNode> & { name: string }): ApiNode {
  return {
    path: overrides.name,
    kind: 'const',
    signature: 'string',
    children: [],
    typeId: overrides.name,
    position: 'output',
    modifiers: {},
    ...overrides,
  }
}

function makeTree(exports: ApiNode[], version = '1.0.0'): ApiTree {
  return { packageName: 'test', version, entryPoint: '.', exports }
}

describe('diffApiTrees', () => {
  it('detects an added export', () => {
    const a = makeNode({ name: 'a' })
    const b = makeNode({ name: 'b' })
    const oldTree = makeTree([a])
    const newTree = makeTree([a, b])

    const changes = diffApiTrees(oldTree, newTree)

    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('added')
    expect(changes[0].path).toBe('b')
    expect(changes[0].semver).toBe('minor')
  })

  it('detects a removed export', () => {
    const a = makeNode({ name: 'a' })
    const b = makeNode({ name: 'b' })
    const oldTree = makeTree([a, b])
    const newTree = makeTree([a])

    const changes = diffApiTrees(oldTree, newTree)

    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('removed')
    expect(changes[0].path).toBe('b')
    expect(changes[0].semver).toBe('major')
  })

  it('detects a changed export', () => {
    const oldA = makeNode({ name: 'a', typeId: 'old', signature: 'old-sig' })
    const newA = makeNode({ name: 'a', typeId: 'new', signature: 'new-sig' })
    const oldTree = makeTree([oldA])
    const newTree = makeTree([newA])

    const changes = diffApiTrees(oldTree, newTree)

    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('changed')
    expect(changes[0].oldSignature).toBe('old-sig')
    expect(changes[0].newSignature).toBe('new-sig')
    expect(changes[0].semver).toBe('major')
  })

  it('returns empty array when trees are identical', () => {
    const a = makeNode({ name: 'a' })
    const b = makeNode({ name: 'b' })
    const oldTree = makeTree([a, b])
    const newTree = makeTree([a, b])

    const changes = diffApiTrees(oldTree, newTree)

    expect(changes).toHaveLength(0)
  })

  it('recursively diffs children and produces nested paths', () => {
    const oldConfig = makeNode({
      name: 'Config',
      kind: 'interface',
      typeId: 'config-v1',
      children: [
        makeNode({ name: 'port', path: 'Config.port', typeId: 'port-old', signature: 'number' }),
        makeNode({ name: 'host', path: 'Config.host', typeId: 'host-same', signature: 'string' }),
      ],
    })
    const newConfig = makeNode({
      name: 'Config',
      kind: 'interface',
      typeId: 'config-v2',
      children: [
        makeNode({ name: 'port', path: 'Config.port', typeId: 'port-new', signature: 'string' }),
        makeNode({ name: 'host', path: 'Config.host', typeId: 'host-same', signature: 'string' }),
      ],
    })

    const changes = diffApiTrees(makeTree([oldConfig]), makeTree([newConfig]))

    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('changed')
    expect(changes[0].path).toBe('Config.port')
    expect(changes[0].parentKind).toBe('interface')
  })

  it('detects an added child property', () => {
    const oldIface = makeNode({
      name: 'Options',
      kind: 'interface',
      typeId: 'opts-v1',
      children: [
        makeNode({ name: 'verbose', path: 'Options.verbose', typeId: 'verbose' }),
      ],
    })
    const newIface = makeNode({
      name: 'Options',
      kind: 'interface',
      typeId: 'opts-v2',
      children: [
        makeNode({ name: 'verbose', path: 'Options.verbose', typeId: 'verbose' }),
        makeNode({ name: 'debug', path: 'Options.debug', typeId: 'debug' }),
      ],
    })

    const changes = diffApiTrees(makeTree([oldIface]), makeTree([newIface]))

    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('added')
    expect(changes[0].path).toBe('Options.debug')
    expect(changes[0].parentKind).toBe('interface')
  })

  it('detects a removed child property', () => {
    const oldIface = makeNode({
      name: 'Options',
      kind: 'interface',
      typeId: 'opts-v1',
      children: [
        makeNode({ name: 'verbose', path: 'Options.verbose', typeId: 'verbose' }),
        makeNode({ name: 'debug', path: 'Options.debug', typeId: 'debug' }),
      ],
    })
    const newIface = makeNode({
      name: 'Options',
      kind: 'interface',
      typeId: 'opts-v2',
      children: [
        makeNode({ name: 'verbose', path: 'Options.verbose', typeId: 'verbose' }),
      ],
    })

    const changes = diffApiTrees(makeTree([oldIface]), makeTree([newIface]))

    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('removed')
    expect(changes[0].path).toBe('Options.debug')
  })

  it('carries oldNode and newNode references on changed exports', () => {
    const oldA = makeNode({ name: 'a', typeId: 'old', signature: 'old-sig' })
    const newA = makeNode({ name: 'a', typeId: 'new', signature: 'new-sig' })
    const oldTree = makeTree([oldA])
    const newTree = makeTree([newA])

    const changes = diffApiTrees(oldTree, newTree)

    expect(changes).toHaveLength(1)
    expect(changes[0].oldNode).toBe(oldA)
    expect(changes[0].newNode).toBe(newA)
  })

  it('carries oldNode on removed exports', () => {
    const a = makeNode({ name: 'a' })
    const b = makeNode({ name: 'b' })
    const oldTree = makeTree([a, b])
    const newTree = makeTree([a])

    const changes = diffApiTrees(oldTree, newTree)

    expect(changes[0].oldNode).toBe(b)
    expect(changes[0].newNode).toBeUndefined()
  })

  it('carries newNode on added exports', () => {
    const a = makeNode({ name: 'a' })
    const b = makeNode({ name: 'b' })
    const oldTree = makeTree([a])
    const newTree = makeTree([a, b])

    const changes = diffApiTrees(oldTree, newTree)

    expect(changes[0].newNode).toBe(b)
    expect(changes[0].oldNode).toBeUndefined()
  })
})
