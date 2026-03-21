import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createTempDts } from './helpers.js'
import { extractApiTree, type ExtractOptions } from '../core/extractor.js'
import { diffApiTrees } from '../core/differ.js'
import { classifyChange } from '../core/classifier.js'

function defaultOpts(filePath: string): ExtractOptions {
  return { packageName: 'test-pkg', version: '1.0.0', entryPoint: filePath }
}

describe('conditional types', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function extract(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return extractApiTree(f.filePath, defaultOpts(f.filePath))
  }

  function diffFixtures(oldContent: string, newContent: string) {
    const oldTree = extract(oldContent)
    const f = createTempDts(newContent)
    cleanups.push(f.cleanup)
    const newTree = extractApiTree(f.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: f.filePath,
    })
    return diffApiTrees(oldTree, newTree)
  }

  it('should extract a simple conditional type', () => {
    const tree = extract(
      `export type IsString<T> = T extends string ? true : false;`,
    )
    expect(tree.exports).toHaveLength(1)
    expect(tree.exports[0].name).toBe('IsString')
    expect(tree.exports[0].kind).toBe('type-alias')
  })

  it('should detect a change when conditional type branches change', () => {
    const changes = diffFixtures(
      `export type IsString<T> = T extends string ? true : false;`,
      `export type IsString<T> = T extends string ? 'yes' : 'no';`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'IsString')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  it('should detect a change when conditional type condition changes', () => {
    const changes = diffFixtures(
      `export type Check<T> = T extends string ? T : never;`,
      `export type Check<T> = T extends number ? T : never;`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'Check')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  it('should detect no changes when conditional type is unchanged', () => {
    const changes = diffFixtures(
      `export type IsArray<T> = T extends unknown[] ? true : false;`,
      `export type IsArray<T> = T extends unknown[] ? true : false;`,
    )
    expect(changes).toHaveLength(0)
  })

  it('should handle nested conditional types', () => {
    const changes = diffFixtures(
      `export type Deep<T> = T extends string ? 'str' : T extends number ? 'num' : 'other';`,
      `export type Deep<T> = T extends string ? 'str' : T extends number ? 'num' : T extends boolean ? 'bool' : 'other';`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0].kind).toBe('changed')
  })

  it('should handle infer keyword in conditional types', () => {
    const tree = extract(
      `export type ReturnOf<T> = T extends (...args: any[]) => infer R ? R : never;`,
    )
    expect(tree.exports).toHaveLength(1)
    expect(tree.exports[0].name).toBe('ReturnOf')
  })
})

describe('mapped types', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function extract(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return extractApiTree(f.filePath, defaultOpts(f.filePath))
  }

  function diffFixtures(oldContent: string, newContent: string) {
    const oldTree = extract(oldContent)
    const f = createTempDts(newContent)
    cleanups.push(f.cleanup)
    const newTree = extractApiTree(f.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: f.filePath,
    })
    return diffApiTrees(oldTree, newTree)
  }

  it('should extract a mapped type', () => {
    const tree = extract(
      `export type Readonly2<T> = { readonly [K in keyof T]: T[K] };`,
    )
    expect(tree.exports).toHaveLength(1)
    expect(tree.exports[0].name).toBe('Readonly2')
    expect(tree.exports[0].kind).toBe('type-alias')
  })

  it('should detect changes when mapped type modifier changes', () => {
    const changes = diffFixtures(
      `export type Props<T> = { [K in keyof T]: T[K] };`,
      `export type Props<T> = { readonly [K in keyof T]: T[K] };`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'Props')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  it('should detect changes when mapped type value changes', () => {
    const changes = diffFixtures(
      `export type Stringify<T> = { [K in keyof T]: string };`,
      `export type Stringify<T> = { [K in keyof T]: number };`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'Stringify')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  it('should detect no changes for identical mapped types', () => {
    const changes = diffFixtures(
      `export type Partial2<T> = { [K in keyof T]?: T[K] };`,
      `export type Partial2<T> = { [K in keyof T]?: T[K] };`,
    )
    expect(changes).toHaveLength(0)
  })

  it('should handle mapped types with key remapping', () => {
    const tree = extract(
      `export type Getters<T> = { [K in keyof T as \`get\${Capitalize<string & K>}\`]: () => T[K] };`,
    )
    expect(tree.exports).toHaveLength(1)
    expect(tree.exports[0].name).toBe('Getters')
  })
})

describe('template literal types', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function extract(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return extractApiTree(f.filePath, defaultOpts(f.filePath))
  }

  function diffFixtures(oldContent: string, newContent: string) {
    const oldTree = extract(oldContent)
    const f = createTempDts(newContent)
    cleanups.push(f.cleanup)
    const newTree = extractApiTree(f.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: f.filePath,
    })
    return diffApiTrees(oldTree, newTree)
  }

  it('should extract a template literal type', () => {
    const tree = extract(
      'export type Route = `/${string}`;',
    )
    expect(tree.exports).toHaveLength(1)
    expect(tree.exports[0].name).toBe('Route')
    expect(tree.exports[0].kind).toBe('type-alias')
  })

  it('should detect changes when template literal type changes', () => {
    const changes = diffFixtures(
      'export type EventName = `on${string}`;',
      'export type EventName = `on${string}` | `handle${string}`;',
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'EventName')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  it('should detect no changes for identical template literal types', () => {
    const changes = diffFixtures(
      'export type Id = `id_${number}`;',
      'export type Id = `id_${number}`;',
    )
    expect(changes).toHaveLength(0)
  })

  it('should handle complex template literal types with unions', () => {
    const changes = diffFixtures(
      "export type Color = `${'red' | 'blue'}-${'light' | 'dark'}`;",
      "export type Color = `${'red' | 'blue' | 'green'}-${'light' | 'dark'}`;",
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0].kind).toBe('changed')
  })
})

describe('barrel re-exports (export * from)', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  it('should extract exports from wildcard re-exports', () => {
    const dir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    writeFileSync(
      join(dir, 'utils.d.ts'),
      `export declare function helper(): void;\nexport declare const VERSION: string;\n`,
    )

    writeFileSync(
      join(dir, 'index.d.ts'),
      `export * from './utils.js';\n`,
    )

    const entryPath = join(dir, 'index.d.ts')
    const tree = extractApiTree(entryPath, defaultOpts(entryPath))

    const names = tree.exports.map((e) => e.name)
    expect(names).toContain('helper')
    expect(names).toContain('VERSION')
  })

  it('should detect changes in wildcard re-exported symbols', () => {
    const oldDir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(oldDir, { recursive: true })
    cleanups.push(() => rmSync(oldDir, { recursive: true, force: true }))

    writeFileSync(join(oldDir, 'utils.d.ts'), `export declare function helper(): string;\n`)
    writeFileSync(join(oldDir, 'index.d.ts'), `export * from './utils.js';\n`)

    const newDir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(newDir, { recursive: true })
    cleanups.push(() => rmSync(newDir, { recursive: true, force: true }))

    writeFileSync(join(newDir, 'utils.d.ts'), `export declare function helper(): number;\n`)
    writeFileSync(join(newDir, 'index.d.ts'), `export * from './utils.js';\n`)

    const oldTree = extractApiTree(join(oldDir, 'index.d.ts'), {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: join(oldDir, 'index.d.ts'),
    })
    const newTree = extractApiTree(join(newDir, 'index.d.ts'), {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: join(newDir, 'index.d.ts'),
    })

    const changes = diffApiTrees(oldTree, newTree)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path.includes('helper'))
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  it('should detect removed symbols from barrel re-exports', () => {
    const oldDir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(oldDir, { recursive: true })
    cleanups.push(() => rmSync(oldDir, { recursive: true, force: true }))

    writeFileSync(join(oldDir, 'a.d.ts'), `export declare const A: string;\n`)
    writeFileSync(join(oldDir, 'b.d.ts'), `export declare const B: number;\n`)
    writeFileSync(join(oldDir, 'index.d.ts'), `export * from './a.js';\nexport * from './b.js';\n`)

    const newDir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(newDir, { recursive: true })
    cleanups.push(() => rmSync(newDir, { recursive: true, force: true }))

    writeFileSync(join(newDir, 'a.d.ts'), `export declare const A: string;\n`)
    writeFileSync(join(newDir, 'index.d.ts'), `export * from './a.js';\n`)

    const oldTree = extractApiTree(join(oldDir, 'index.d.ts'), {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: join(oldDir, 'index.d.ts'),
    })
    const newTree = extractApiTree(join(newDir, 'index.d.ts'), {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: join(newDir, 'index.d.ts'),
    })

    const changes = diffApiTrees(oldTree, newTree)
    const removed = changes.find((c) => c.kind === 'removed' && c.path === 'B')
    expect(removed).toBeDefined()
  })
})

describe('empty packages / no exports', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  it('should return an empty export list for a .d.ts with no exports', () => {
    const f = createTempDts(`declare const internal: string;`)
    cleanups.push(f.cleanup)

    const tree = extractApiTree(f.filePath, defaultOpts(f.filePath))
    expect(tree.exports).toHaveLength(0)
  })

  it('should produce no changes when both versions have no exports', () => {
    const f1 = createTempDts(`declare const a: string;`)
    const f2 = createTempDts(`declare const b: number;`)
    cleanups.push(f1.cleanup, f2.cleanup)

    const oldTree = extractApiTree(f1.filePath, defaultOpts(f1.filePath))
    const newTree = extractApiTree(f2.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: f2.filePath,
    })

    const changes = diffApiTrees(oldTree, newTree)
    expect(changes).toHaveLength(0)
  })

  it('should detect all additions when old version has no exports', () => {
    const f1 = createTempDts(`declare const internal: string;`)
    const f2 = createTempDts(`export declare const API: string;\nexport declare function init(): void;`)
    cleanups.push(f1.cleanup, f2.cleanup)

    const oldTree = extractApiTree(f1.filePath, defaultOpts(f1.filePath))
    const newTree = extractApiTree(f2.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: f2.filePath,
    })

    const changes = diffApiTrees(oldTree, newTree)
    expect(changes).toHaveLength(2)
    expect(changes.every((c) => c.kind === 'added')).toBe(true)
  })

  it('should detect all removals when new version has no exports', () => {
    const f1 = createTempDts(`export declare const API: string;\nexport declare function init(): void;`)
    const f2 = createTempDts(`declare const internal: string;`)
    cleanups.push(f1.cleanup, f2.cleanup)

    const oldTree = extractApiTree(f1.filePath, defaultOpts(f1.filePath))
    const newTree = extractApiTree(f2.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: f2.filePath,
    })

    const changes = diffApiTrees(oldTree, newTree)
    expect(changes).toHaveLength(2)
    expect(changes.every((c) => c.kind === 'removed')).toBe(true)
    for (const change of changes) {
      const semver = classifyChange(change, change.oldNode, change.newNode)
      expect(semver).toBe('major')
    }
  })
})

describe('mutually recursive types', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  it('should handle mutually recursive types without stack overflow', () => {
    const f = createTempDts(`
      export interface A { b: B; value: string; }
      export interface B { a: A; count: number; }
    `)
    cleanups.push(f.cleanup)

    const tree = extractApiTree(f.filePath, defaultOpts(f.filePath))
    expect(tree.exports).toHaveLength(2)

    const a = tree.exports.find((e) => e.name === 'A')
    const b = tree.exports.find((e) => e.name === 'B')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.children.some((c) => c.name === 'b')).toBe(true)
    expect(b!.children.some((c) => c.name === 'a')).toBe(true)
  })

  it('should detect changes in mutually recursive types', () => {
    const f1 = createTempDts(`
      export interface Expr { left: Term; op: string; }
      export interface Term { value: Expr | number; }
    `)
    const f2 = createTempDts(`
      export interface Expr { left: Term; op: string; right: Term; }
      export interface Term { value: Expr | number; }
    `)
    cleanups.push(f1.cleanup, f2.cleanup)

    const oldTree = extractApiTree(f1.filePath, defaultOpts(f1.filePath))
    const newTree = extractApiTree(f2.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: f2.filePath,
    })

    const changes = diffApiTrees(oldTree, newTree)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const added = changes.find((c) => c.kind === 'added' && c.path.includes('right'))
    expect(added).toBeDefined()
  })
})
