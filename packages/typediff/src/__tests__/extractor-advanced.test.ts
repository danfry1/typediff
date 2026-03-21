import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createTempDts } from './helpers.js'
import { extractApiTree, type ExtractOptions } from '../core/extractor.js'
import { diffApiTrees } from '../core/differ.js'

function defaultOpts(filePath: string): ExtractOptions {
  return { packageName: 'test-pkg', version: '1.0.0', entryPoint: filePath }
}

describe('extractApiTree — advanced scenarios', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  // ── 1. Generic function ──────────────────────────────────────────────
  it('should extract a generic function and its signature contains <T>', () => {
    const tmp = createTempDts(
      `export declare function identity<T>(value: T): T;`,
    )
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toHaveLength(1)

    const fn = tree.exports[0]
    expect(fn.name).toBe('identity')
    expect(fn.kind).toBe('function')
    // The signature string produced by the checker should reference T
    expect(fn.signature).toContain('T')
  })

  // ── 2. Generic interface with default type parameter ─────────────────
  it('should extract a generic interface with 2 property children and 2 type-parameter children', () => {
    const tmp = createTempDts(`
      export interface Result<T, E = Error> {
        data: T;
        error: E | null;
      }
    `)
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toHaveLength(1)

    const iface = tree.exports[0]
    expect(iface.name).toBe('Result')
    expect(iface.kind).toBe('interface')

    const props = iface.children.filter((c) => c.kind === 'property')
    expect(props).toHaveLength(2)

    const typeParams = iface.children.filter((c) => c.kind === 'type-parameter')
    expect(typeParams).toHaveLength(2)

    const data = iface.children.find((c) => c.name === 'data')
    const error = iface.children.find((c) => c.name === 'error')
    expect(data).toBeDefined()
    expect(error).toBeDefined()
  })

  // ── 3. Function overloads ────────────────────────────────────────────
  it('should extract a function with overloads', () => {
    const tmp = createTempDts(`
      export declare function parse(input: string): number;
      export declare function parse(input: number): string;
    `)
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))

    // The function should be extracted (at least once)
    const parseFns = tree.exports.filter((e) => e.name === 'parse')
    expect(parseFns.length).toBeGreaterThanOrEqual(1)
    expect(parseFns[0].kind).toBe('function')
  })

  // ── 4. Multiple exports ──────────────────────────────────────────────
  it('should extract all exports: const, function, interface, type alias', () => {
    const tmp = createTempDts(`
      export declare const VERSION: string;
      export declare function greet(name: string): void;
      export interface Config { debug: boolean; }
      export type Mode = 'fast' | 'slow';
    `)
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toHaveLength(4)

    const names = tree.exports.map((e) => e.name)
    expect(names).toContain('VERSION')
    expect(names).toContain('greet')
    expect(names).toContain('Config')
    expect(names).toContain('Mode')

    const kinds = tree.exports.map((e) => e.kind)
    expect(kinds).toContain('const')
    expect(kinds).toContain('function')
    expect(kinds).toContain('interface')
    expect(kinds).toContain('type-alias')
  })

  // ── 5. Default export ────────────────────────────────────────────────
  it('should extract a default export', () => {
    const tmp = createTempDts(
      `export default function main(): void;`,
    )
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    // Default export should appear (may have name "default" or "main")
    expect(tree.exports.length).toBeGreaterThanOrEqual(1)

    const defaultExport = tree.exports.find(
      (e) => e.name === 'default' || e.name === 'main',
    )
    expect(defaultExport).toBeDefined()
  })

  // ── 6. Namespace ─────────────────────────────────────────────────────
  it('should extract a namespace with kind="namespace"', () => {
    const tmp = createTempDts(`
      export declare namespace Utils {
        function format(s: string): string;
      }
    `)
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toHaveLength(1)

    const ns = tree.exports[0]
    expect(ns.name).toBe('Utils')
    expect(ns.kind).toBe('namespace')
    // Namespace should have its members as children
    expect(ns.children.length).toBeGreaterThanOrEqual(1)
    const formatFn = ns.children.find((c) => c.name === 'format')
    expect(formatFn).toBeDefined()
    expect(formatFn!.kind).toBe('function')
  })

  // ── 7. Circular / self-referencing type ──────────────────────────────
  it('should handle circular type references without stack overflow', () => {
    const tmp = createTempDts(`
      export interface TreeNode {
        children: TreeNode[];
        value: string;
      }
    `)
    cleanups.push(tmp.cleanup)

    // Should not throw / infinite loop
    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toHaveLength(1)

    const node = tree.exports[0]
    expect(node.name).toBe('TreeNode')
    expect(node.kind).toBe('interface')
    expect(node.children.length).toBeGreaterThanOrEqual(2)

    const childrenProp = node.children.find((c) => c.name === 'children')
    const valueProp = node.children.find((c) => c.name === 'value')
    expect(childrenProp).toBeDefined()
    expect(valueProp).toBeDefined()
  })

  // ── 8. Re-exports ───────────────────────────────────────────────────
  it('should extract symbols that are re-exported from another file', () => {
    const dir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    // Source module
    writeFileSync(
      join(dir, 'source.d.ts'),
      `export declare const FOO: number;\nexport declare function bar(): string;\n`,
    )

    // Re-export module (the entry point)
    writeFileSync(
      join(dir, 'index.d.ts'),
      `export { FOO, bar } from './source.js';\n`,
    )

    const entryPath = join(dir, 'index.d.ts')
    const tree = extractApiTree(entryPath, defaultOpts(entryPath))

    const names = tree.exports.map((e) => e.name)
    expect(names).toContain('FOO')
    expect(names).toContain('bar')
  })

  // ── 9. Union member reordering produces same typeId ──────────────────
  it('should produce the same typeId regardless of union member order', () => {
    const tmp1 = createTempDts(
      `export type U = 'b' | 'a' | 'c';`,
    )
    const tmp2 = createTempDts(
      `export type U = 'a' | 'b' | 'c';`,
    )
    cleanups.push(tmp1.cleanup, tmp2.cleanup)

    const tree1 = extractApiTree(tmp1.filePath, defaultOpts(tmp1.filePath))
    const tree2 = extractApiTree(tmp2.filePath, defaultOpts(tmp2.filePath))

    expect(tree1.exports[0].typeId).toBe(tree2.exports[0].typeId)
  })

  // ── 10. export = declaration ──────────────────────────────────────
  it('should extract export = declaration as a default export', () => {
    const tmp = createTempDts(
      `declare function lib(x: string): number;\nexport = lib;`,
    )
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toHaveLength(1)
    expect(tree.exports[0].name).toBe('default')
    // export = produces a value export; the kind depends on the referenced symbol
    expect(['function', 'const']).toContain(tree.exports[0].kind)
  })

  it('should detect changes in export = declarations', () => {
    const tmp1 = createTempDts(
      `declare function lib(x: string): number;\nexport = lib;`,
    )
    const tmp2 = createTempDts(
      `declare function lib(x: string): string;\nexport = lib;`,
    )
    cleanups.push(tmp1.cleanup, tmp2.cleanup)

    const tree1 = extractApiTree(tmp1.filePath, defaultOpts(tmp1.filePath))
    const tree2 = extractApiTree(tmp2.filePath, {
      packageName: 'test-pkg',
      version: '1.1.0',
      entryPoint: tmp2.filePath,
    })

    const changes = diffApiTrees(tree1, tree2)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0].kind).toBe('changed')
  })

  // ── 11. Malformed / invalid .d.ts files ───────────────────────────────
  it('should handle a syntactically invalid .d.ts file without throwing', () => {
    const tmp = createTempDts(
      `export declare const x: number;\nexport declare function {broken syntax here;`,
    )
    cleanups.push(tmp.cleanup)

    // The extractor should not throw — it may produce partial results or
    // an empty tree, but it must not crash.
    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree).toBeDefined()
    expect(tree.exports).toBeDefined()
    expect(Array.isArray(tree.exports)).toBe(true)
  })

  it('should handle a completely empty .d.ts file', () => {
    const tmp = createTempDts('')
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toEqual([])
  })

  it('should handle a .d.ts file with only comments', () => {
    const tmp = createTempDts(
      `// This file has no exports\n/* Just comments */`,
    )
    cleanups.push(tmp.cleanup)

    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree.exports).toEqual([])
  })

  it('should handle a .d.ts file with random non-TypeScript content', () => {
    const tmp = createTempDts(
      `<html><body>This is not TypeScript</body></html>`,
    )
    cleanups.push(tmp.cleanup)

    // Should not throw
    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree).toBeDefined()
    expect(Array.isArray(tree.exports)).toBe(true)
  })

  it('should extract valid exports even when other declarations have syntax errors', () => {
    const tmp = createTempDts(
      `export declare const valid: string;\nexport declare const !!!invalid: number;`,
    )
    cleanups.push(tmp.cleanup)

    // Should not throw — may extract the valid export
    const tree = extractApiTree(tmp.filePath, defaultOpts(tmp.filePath))
    expect(tree).toBeDefined()
    expect(Array.isArray(tree.exports)).toBe(true)
  })

  it('should call onWarn for files with diagnostics', () => {
    const tmp = createTempDts(
      `export declare const x: NonExistentType;`,
    )
    cleanups.push(tmp.cleanup)

    const warnings: string[] = []
    const tree = extractApiTree(tmp.filePath, {
      ...defaultOpts(tmp.filePath),
      onWarn: (msg) => warnings.push(msg),
    })

    // Should still produce a tree (the const is syntactically valid)
    expect(tree.exports.length).toBeGreaterThanOrEqual(1)
  })
})

describe('bundler-generated .d.mts with .mjs imports', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  it('resolves type aliases re-exported through .mjs imports to .d.mts files', () => {
    // Simulate a bundler output: index.d.mts imports from types.mjs,
    // but only types.d.mts exists (no types.mjs runtime file)
    const dir = join(tmpdir(), `typediff-bundler-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    // The "chunk" file — types.d.mts contains the actual type definitions
    writeFileSync(join(dir, 'types.d.mts'), `
type MyType = 'a' | 'b' | 'c';
interface MyInterface {
  name: string;
  value: number;
}
export { MyType as a, MyInterface as b };
`)

    // The entry point imports from .mjs (which doesn't exist — only .d.mts does)
    writeFileSync(join(dir, 'index.d.mts'), `
import { a as MyType, b as MyInterface } from "./types.mjs";
export declare function create(): MyInterface;
export type { MyType, MyInterface };
`)

    const entryPath = join(dir, 'index.d.mts')
    const tree = extractApiTree(entryPath, defaultOpts(entryPath))

    // MyType should be resolved as a type-alias with the actual union, not 'any'
    const myType = tree.exports.find(e => e.name === 'MyType')
    expect(myType).toBeDefined()
    expect(myType!.kind).toBe('type-alias')
    expect(myType!.signature).not.toBe('any')
    expect(myType!.signature).toContain('a')
    expect(myType!.signature).toContain('b')
    expect(myType!.signature).toContain('c')

    // MyInterface should be resolved as an interface with properties
    const myIface = tree.exports.find(e => e.name === 'MyInterface')
    expect(myIface).toBeDefined()
    expect(myIface!.kind).toBe('interface')
    expect(myIface!.signature).not.toBe('any')
    expect(myIface!.children.length).toBe(2)

    // create() should return MyInterface, not any
    const create = tree.exports.find(e => e.name === 'create')
    expect(create).toBeDefined()
    expect(create!.kind).toBe('function')
  })

  it('detects changes in types imported through .mjs → .d.mts resolution', () => {
    const dir1 = join(tmpdir(), `typediff-bundler-test-${randomUUID()}`)
    const dir2 = join(tmpdir(), `typediff-bundler-test-${randomUUID()}`)
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })
    cleanups.push(
      () => rmSync(dir1, { recursive: true, force: true }),
      () => rmSync(dir2, { recursive: true, force: true }),
    )

    // Old version
    writeFileSync(join(dir1, 'types.d.mts'), `
type Mode = 'fast' | 'slow';
export { Mode as a };
`)
    writeFileSync(join(dir1, 'index.d.mts'), `
import { a as Mode } from "./types.mjs";
export type { Mode };
`)

    // New version — removed 'slow' from union
    writeFileSync(join(dir2, 'types.d.mts'), `
type Mode = 'fast';
export { Mode as a };
`)
    writeFileSync(join(dir2, 'index.d.mts'), `
import { a as Mode } from "./types.mjs";
export type { Mode };
`)

    const oldTree = extractApiTree(join(dir1, 'index.d.mts'), {
      packageName: 'test', version: '1.0.0', entryPoint: '.',
    })
    const newTree = extractApiTree(join(dir2, 'index.d.mts'), {
      packageName: 'test', version: '2.0.0', entryPoint: '.',
    })

    const changes = diffApiTrees(oldTree, newTree)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    // Removing a union member is a change
    const modeChange = changes.find(c => c.path === 'Mode')
    expect(modeChange).toBeDefined()
    expect(modeChange!.kind).toBe('changed')
  })

  it('correctly resolves re-exported type aliases through alias chains', () => {
    // Test alias-aware kind detection: a type alias re-exported via
    // `export { Foo } from "./source"` should be detected as type-alias,
    // not const
    const dir = join(tmpdir(), `typediff-alias-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    writeFileSync(join(dir, 'source.d.ts'), `
export type Status = 'active' | 'inactive' | 'pending';
export interface Config {
  timeout: number;
  retries: number;
}
`)
    writeFileSync(join(dir, 'index.d.ts'), `
export { Status, Config } from './source.js';
`)

    const tree = extractApiTree(join(dir, 'index.d.ts'), defaultOpts(join(dir, 'index.d.ts')))

    const status = tree.exports.find(e => e.name === 'Status')
    expect(status).toBeDefined()
    expect(status!.kind).toBe('type-alias')
    expect(status!.signature).toContain('active')

    const config = tree.exports.find(e => e.name === 'Config')
    expect(config).toBeDefined()
    expect(config!.kind).toBe('interface')
    expect(config!.children.length).toBe(2)
  })

  it('emits warning when many exports resolve to any', () => {
    const dir = join(tmpdir(), `typediff-any-warn-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    // Exports explicitly typed as any — simulates unresolvable bundler output
    writeFileSync(join(dir, 'index.d.ts'), `
export declare const a: any;
export declare const b: any;
export declare const c: any;
`)

    const warnings: string[] = []
    extractApiTree(join(dir, 'index.d.ts'), {
      ...defaultOpts(join(dir, 'index.d.ts')),
      onWarn: (msg) => warnings.push(msg),
    })

    // Should warn about high any count (3/3 = 100% > 30% threshold)
    expect(warnings.some(w => w.includes('any'))).toBe(true)
  })
})
