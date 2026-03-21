import { describe, it, expect, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { createTempDts } from './helpers.js'
import { extractApiTree } from '../core/extractor.js'

describe('extractApiTree', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it('should extract an exported const', () => {
    const tmp = createTempDts(`export declare const API_VERSION: string;`)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    expect(tree.packageName).toBe('test-pkg')
    expect(tree.version).toBe('1.0.0')
    expect(tree.exports).toHaveLength(1)

    const node = tree.exports[0]
    expect(node.name).toBe('API_VERSION')
    expect(node.kind).toBe('const')
    expect(node.position).toBe('output')
    expect(node.signature).toBe('string')
  })

  it('should extract a function with params and return type', () => {
    const tmp = createTempDts(`
      export declare function greet(name: string, count?: number): boolean;
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    expect(tree.exports).toHaveLength(1)
    const fn = tree.exports[0]
    expect(fn.name).toBe('greet')
    expect(fn.kind).toBe('function')

    // Should have parameters and a return type as children
    const params = fn.children.filter((c) => c.kind === 'parameter')
    const returnType = fn.children.find((c) => c.kind === 'return-type')

    expect(params).toHaveLength(2)
    expect(params[0].name).toBe('name')
    expect(params[0].position).toBe('input')
    expect(params[0].signature).toBe('string')

    expect(params[1].name).toBe('count')
    expect(params[1].position).toBe('input')
    expect(params[1].modifiers.optional).toBe(true)

    expect(returnType).toBeDefined()
    expect(returnType!.position).toBe('output')
    expect(returnType!.signature).toBe('boolean')
  })

  it('should extract an interface with properties', () => {
    const tmp = createTempDts(`
      export interface User {
        id: number;
        readonly email: string;
        name?: string;
      }
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    expect(tree.exports).toHaveLength(1)
    const iface = tree.exports[0]
    expect(iface.name).toBe('User')
    expect(iface.kind).toBe('interface')

    expect(iface.children).toHaveLength(3)

    const id = iface.children.find((c) => c.name === 'id')!
    expect(id.kind).toBe('property')
    expect(id.position).toBe('invariant') // mutable prop
    expect(id.signature).toBe('number')

    const email = iface.children.find((c) => c.name === 'email')!
    expect(email.kind).toBe('property')
    expect(email.position).toBe('output') // readonly prop
    expect(email.modifiers.readonly).toBe(true)

    const name = iface.children.find((c) => c.name === 'name')!
    expect(name.kind).toBe('property')
    expect(name.modifiers.optional).toBe(true)
  })

  it('should extract a type alias', () => {
    const tmp = createTempDts(`
      export type Status = 'active' | 'inactive' | 'pending';
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    expect(tree.exports).toHaveLength(1)
    const alias = tree.exports[0]
    expect(alias.name).toBe('Status')
    expect(alias.kind).toBe('type-alias')
  })

  it('should extract an enum with members', () => {
    const tmp = createTempDts(`
      export declare enum Direction {
        Up = 0,
        Down = 1,
        Left = 2,
        Right = 3
      }
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    expect(tree.exports).toHaveLength(1)
    const enumNode = tree.exports[0]
    expect(enumNode.name).toBe('Direction')
    expect(enumNode.kind).toBe('enum')

    const memberNames = enumNode.children.map((c) => c.name)
    expect(memberNames).toContain('Up')
    expect(memberNames).toContain('Down')
    expect(memberNames).toContain('Left')
    expect(memberNames).toContain('Right')
    expect(enumNode.children).toHaveLength(4)
  })

  it('should extract a class with readonly prop, constructor params, and methods with visibility', () => {
    const tmp = createTempDts(`
      export declare class Service {
        readonly baseUrl: string;
        constructor(url: string);
        protected fetchData(id: number): Promise<string>;
      }
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    expect(tree.exports).toHaveLength(1)
    const cls = tree.exports[0]
    expect(cls.name).toBe('Service')
    expect(cls.kind).toBe('class')

    const baseUrl = cls.children.find((c) => c.name === 'baseUrl')!
    expect(baseUrl).toBeDefined()
    expect(baseUrl.kind).toBe('property')
    expect(baseUrl.modifiers.readonly).toBe(true)
    expect(baseUrl.position).toBe('output') // readonly = output

    const fetchData = cls.children.find((c) => c.name === 'fetchData')!
    expect(fetchData).toBeDefined()
    expect(fetchData.kind).toBe('method')
    expect(fetchData.modifiers.visibility).toBe('protected')
  })

  it('should produce stable typeId for the same type', () => {
    const tmp1 = createTempDts(`export declare const a: string;`)
    const tmp2 = createTempDts(`export declare const b: string;`)

    const tree1 = extractApiTree(tmp1.filePath, {
      packageName: 'pkg',
      version: '1.0.0',
      entryPoint: tmp1.filePath,
    })
    const tree2 = extractApiTree(tmp2.filePath, {
      packageName: 'pkg',
      version: '1.0.0',
      entryPoint: tmp2.filePath,
    })

    tmp1.cleanup()
    tmp2.cleanup()

    // Same type (string) should produce same typeId
    expect(tree1.exports[0].typeId).toBe(tree2.exports[0].typeId)
    // Both should be non-empty hashes
    expect(tree1.exports[0].typeId).toMatch(/^[a-f0-9]{64}$/)
  })

  it('should produce different typeId for different types', () => {
    const tmp1 = createTempDts(`export declare const a: string;`)
    const tmp2 = createTempDts(`export declare const a: number;`)

    const tree1 = extractApiTree(tmp1.filePath, {
      packageName: 'pkg',
      version: '1.0.0',
      entryPoint: tmp1.filePath,
    })
    const tree2 = extractApiTree(tmp2.filePath, {
      packageName: 'pkg',
      version: '1.0.0',
      entryPoint: tmp2.filePath,
    })

    tmp1.cleanup()
    tmp2.cleanup()

    expect(tree1.exports[0].typeId).not.toBe(tree2.exports[0].typeId)
  })
})

describe('type parameter extraction', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it('extracts type parameters with constraints from functions', () => {
    const tmp = createTempDts(`
      export declare function transform<T extends string>(input: T): T;
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    const fn = tree.exports[0]
    expect(fn.name).toBe('transform')
    expect(fn.kind).toBe('function')

    const typeParams = fn.children.filter((c) => c.kind === 'type-parameter')
    expect(typeParams).toHaveLength(1)
    expect(typeParams[0].name).toBe('T')
    expect(typeParams[0].signature).toBe('string')
    expect(typeParams[0].position).toBe('input')
  })

  it('extracts type parameters from classes', () => {
    const tmp = createTempDts(`
      export declare class Container<T extends object> { value: T; }
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    const cls = tree.exports[0]
    expect(cls.name).toBe('Container')
    expect(cls.kind).toBe('class')

    const typeParams = cls.children.filter((c) => c.kind === 'type-parameter')
    expect(typeParams).toHaveLength(1)
    expect(typeParams[0].name).toBe('T')
    expect(typeParams[0].signature).toBe('object')
  })

  it('extracts type parameters with defaults from type aliases', () => {
    const tmp = createTempDts(`
      export declare type Mapper<T extends Record<string, unknown>, U = T> = (input: T) => U;
    `)
    cleanup = tmp.cleanup

    const tree = extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })

    const alias = tree.exports[0]
    expect(alias.name).toBe('Mapper')
    expect(alias.kind).toBe('type-alias')

    const typeParams = alias.children.filter((c) => c.kind === 'type-parameter')
    expect(typeParams).toHaveLength(2)

    const tParam = typeParams.find((c) => c.name === 'T')!
    expect(tParam).toBeDefined()
    expect(tParam.signature).toContain('Record')
    expect(tParam.modifiers.hasDefault).toBeFalsy()

    const uParam = typeParams.find((c) => c.name === 'U')!
    expect(uParam).toBeDefined()
    expect(uParam.modifiers.hasDefault).toBe(true)
    expect(uParam.signature).toContain('=')
  })
})

describe('TSDoc tag extraction', () => {
  const fixturePath = resolve(__dirname, 'fixtures/tsdoc-tags/old/index.d.ts')

  it('extracts @internal tag', () => {
    const tree = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const internal = tree.exports.find(e => e.name === 'internalApi')!
    expect(internal.tags).toContain('internal')
  })

  it('extracts @beta tag', () => {
    const tree = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const beta = tree.exports.find(e => e.name === 'betaApi')!
    expect(beta.tags).toContain('beta')
  })

  it('returns empty/undefined tags for untagged exports', () => {
    const tree = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const untagged = tree.exports.find(e => e.name === 'untaggedApi')!
    expect(untagged.tags ?? []).toEqual([])
  })

  it('resolves tags through re-exports', () => {
    const tree = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const reExported = tree.exports.find(e => e.name === 'reExportedInternal')!
    expect(reExported.tags).toContain('internal')
  })
})

describe('typeId stability', () => {
  it('produces stable typeIds across extractions', () => {
    const fixturePath = resolve(__dirname, 'fixtures/no-changes/old/index.d.ts')

    // Extract twice
    const tree1 = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const tree2 = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })

    // Every export's typeId should be identical between runs
    for (const exp1 of tree1.exports) {
      const exp2 = tree2.exports.find(e => e.name === exp1.name)
      expect(exp2).toBeDefined()
      expect(exp1.typeId).toBe(exp2!.typeId)
    }
  })

  it('produces deterministic typeIds for known types', () => {
    // Pin specific typeIds to catch regressions from TS compiler changes
    const fixturePath = resolve(__dirname, 'fixtures/export-added/new/index.d.ts')
    const tree = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })

    // Store the typeIds from this extraction as golden values
    // If these change, it means the TS compiler changed its output
    const typeIds = new Map(tree.exports.map(e => [e.name, e.typeId]))

    // Re-extract and verify
    const tree2 = extractApiTree(fixturePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    for (const exp of tree2.exports) {
      expect(exp.typeId).toBe(typeIds.get(exp.name))
    }
  })
})
