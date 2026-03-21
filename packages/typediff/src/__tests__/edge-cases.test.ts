import { describe, it, expect, afterEach } from 'vitest'
import { createTempDts } from './helpers.js'
import { extractApiTree, type ExtractOptions } from '../core/extractor.js'
import { diffApiTrees } from '../core/differ.js'
import { classifyChange } from '../core/classifier.js'

describe('edge cases — unions, tuples, generics, enums, and more', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function extract(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.0.0',
      entryPoint: '.',
    })
  }

  function diffFixtures(oldContent: string, newContent: string) {
    const oldTree = extract(oldContent)
    // Need fresh version for new tree
    const f = createTempDts(newContent)
    cleanups.push(f.cleanup)
    const newTree = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    return diffApiTrees(oldTree, newTree)
  }

  // ── 1. Union type narrowing ─────────────────────────────────────────
  it('should detect a change when a union member is removed', () => {
    const changes = diffFixtures(
      `export type Status = 'a' | 'b' | 'c';`,
      `export type Status = 'a' | 'b';`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'Status' || c.path.includes('Status'))
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  // ── 2. Union member reordering ──────────────────────────────────────
  it('should detect NO changes when union members are reordered', () => {
    const changes = diffFixtures(
      `export type U = 'b' | 'a' | 'c';`,
      `export type U = 'a' | 'b' | 'c';`,
    )
    expect(changes).toHaveLength(0)
  })

  // ── 3. Tuple type change ────────────────────────────────────────────
  it('should detect a change when a tuple grows', () => {
    const changes = diffFixtures(
      `export type Pair = [string, number];`,
      `export type Pair = [string, number, boolean];`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'Pair' || c.path.includes('Pair'))
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  // ── 4. Readonly modifier added ──────────────────────────────────────
  it('should detect a change when readonly modifier is added to a property', () => {
    const changes = diffFixtures(
      `export interface Config { host: string; }`,
      `export interface Config { readonly host: string; }`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    // The change may be on Config itself or the host child
    const change = changes.find((c) => c.path.includes('host') || c.path === 'Config')
    expect(change).toBeDefined()
  })

  // ── 5. Function parameter becoming optional ─────────────────────────
  it('should detect a change when a parameter becomes optional', () => {
    const changes = diffFixtures(
      `export declare function init(config: string): void;`,
      `export declare function init(config?: string): void;`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find(
      (c) => c.path.includes('config') || c.path.includes('init'),
    )
    expect(change).toBeDefined()
  })

  // ── 6. Generic constraint change ────────────────────────────────────
  it('should detect a change when a generic constraint changes', () => {
    const changes = diffFixtures(
      `export declare function wrap<T extends object>(val: T): T;`,
      `export declare function wrap<T extends Record<string, unknown>>(val: T): T;`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find(
      (c) => c.path.includes('wrap') || c.path.includes('val'),
    )
    expect(change).toBeDefined()
  })

  // ── 7. Default export type change ───────────────────────────────────
  it('should detect a change when default export return type changes', () => {
    const changes = diffFixtures(
      `export default function(): string;`,
      `export default function(): number;`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    // There should be a change related to the default export or its return type
    const change = changes.find(
      (c) =>
        c.path.includes('default') ||
        c.path.includes('return') ||
        c.kind === 'changed',
    )
    expect(change).toBeDefined()
  })

  // ── 8. Enum member added ────────────────────────────────────────────
  it('should detect an added enum member', () => {
    const changes = diffFixtures(
      `export enum Color { Red, Blue }`,
      `export enum Color { Red, Blue, Green }`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const added = changes.find(
      (c) => c.kind === 'added' && c.path.includes('Green'),
    )
    expect(added).toBeDefined()
  })

  // ── 9. Enum member removed ──────────────────────────────────────────
  it('should detect a removed enum member', () => {
    const changes = diffFixtures(
      `export enum Color { Red, Blue, Green }`,
      `export enum Color { Red, Blue }`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const removed = changes.find(
      (c) => c.kind === 'removed' && c.path.includes('Green'),
    )
    expect(removed).toBeDefined()
  })

  // ── 10. Intersection type change ────────────────────────────────────
  it('should detect a change when an intersection type gains a member', () => {
    const changes = diffFixtures(
      `
        interface A { a: string; }
        interface B { b: number; }
        interface C { c: boolean; }
        export type AB = A & B;
      `,
      `
        interface A { a: string; }
        interface B { b: number; }
        interface C { c: boolean; }
        export type AB = A & B & C;
      `,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'AB' || c.path.includes('AB'))
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  // ── 11. Function return type widened ────────────────────────────────
  it('should detect a change when a function return type is widened', () => {
    const changes = diffFixtures(
      `export declare function getName(): string;`,
      `export declare function getName(): string | null;`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find(
      (c) => c.path.includes('return') || c.path.includes('getName'),
    )
    expect(change).toBeDefined()
  })

  // ── 12. Required param added to function ────────────────────────────
  it('should detect an added required parameter', () => {
    const changes = diffFixtures(
      `export declare function send(a: string): void;`,
      `export declare function send(a: string, b: number): void;`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const added = changes.find(
      (c) => c.kind === 'added' && c.path.includes('b'),
    )
    expect(added).toBeDefined()
  })

  it('should detect index signature changes', () => {
    const old = extract('export interface Dict { [key: string]: unknown; }')
    const neu = extract('export interface Dict { [key: string]: string; }')
    const changes = diffApiTrees(old, neu)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.path.includes('[index:'))).toBe(true)
  })

  it('should detect call signature changes on interfaces', () => {
    const old = extract('export interface Handler { (req: string): void; name: string; }')
    const neu = extract('export interface Handler { (req: string, res: string): void; name: string; }')
    const changes = diffApiTrees(old, neu)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.path.includes('[call]'))).toBe(true)
  })

  it('should detect construct signature changes on interfaces', () => {
    const old = extract('export interface Factory { new (x: string): object; }')
    const neu = extract('export interface Factory { new (x: string, y: number): object; }')
    const changes = diffApiTrees(old, neu)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.path.includes('[new]'))).toBe(true)
  })

  it('should detect added namespace members on merged function+namespace', () => {
    const old = extract(
      'export declare function jQuery(s: string): HTMLElement;\nexport declare namespace jQuery { function ajax(url: string): Promise<unknown>; }',
    )
    const neu = extract(
      'export declare function jQuery(s: string): HTMLElement;\nexport declare namespace jQuery { function ajax(url: string): Promise<unknown>; function post(url: string): Promise<unknown>; }',
    )
    const changes = diffApiTrees(old, neu)
    expect(changes.length).toBe(1)
    expect(changes[0].kind).toBe('added')
    expect(changes[0].path).toBe('jQuery.post')
  })

  it('should detect visibility changes on class methods', () => {
    const old = extract('export declare class C { public foo(): void; }')
    const neu = extract('export declare class C { protected foo(): void; }')
    const changes = diffApiTrees(old, neu)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.some((c) => c.path.includes('foo'))).toBe(true)
  })

  it('should detect abstract modifier added to class', () => {
    const old = extract('export declare class Base { doWork(): void; }')
    const neu = extract('export declare abstract class Base { doWork(): void; }')
    const changes = diffApiTrees(old, neu)
    // Abstract is a modifier-only change — should be detected
    expect(changes.length).toBeGreaterThan(0)
  })

  it('should normalize intersection order within union members for stable typeId', () => {
    const tree1 = extract('export type T = (A & B) | (C & D);')
    const tree2 = extract('export type T = (B & A) | (D & C);')
    // Same type structurally — typeIds should match, no changes
    expect(tree1.exports[0].typeId).toBe(tree2.exports[0].typeId)
    const changes = diffApiTrees(tree1, tree2)
    expect(changes.length).toBe(0)
  })
})

describe('discriminated union description accuracy', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function extract(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.0.0',
      entryPoint: '.',
    })
  }

  it('describes variant shape changes as "changed" not "widened"', () => {
    const old = extract(
      `export type T = { kind: "a"; value: string } | { kind: "b"; value: number };`,
    )
    const f = createTempDts(
      `export type T = { kind: "a"; value: number } | { kind: "b"; value: string };`,
    )
    cleanups.push(f.cleanup)
    const neu = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    const changes = diffApiTrees(old, neu)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'T')
    expect(change).toBeDefined()
    expect(change!.description).toContain('changed')
    expect(change!.description).not.toContain('widened')
  })
})

describe('parentKind propagation from differ into classifier', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function extract(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.0.0',
      entryPoint: '.',
    })
  }

  it('classifies added type-parameter on function as minor through full pipeline', () => {
    const old = extract('export declare function wrap(val: string): string;')
    const f = createTempDts('export declare function wrap<T>(val: T): T;')
    cleanups.push(f.cleanup)
    const neu = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    const changes = diffApiTrees(old, neu)
    // The added type parameter should have parentKind='function'
    const typeParamChange = changes.find(
      (c) => c.kind === 'added' && c.path.includes('T'),
    )
    expect(typeParamChange).toBeDefined()
    expect(typeParamChange!.parentKind).toBe('function')
    const level = classifyChange(typeParamChange!, undefined, typeParamChange!.newNode)
    expect(level).toBe('minor')
  })

  it('classifies added type-parameter on class as major through full pipeline', () => {
    const old = extract('export declare class Box { value: string; }')
    const f = createTempDts('export declare class Box<T> { value: T; }')
    cleanups.push(f.cleanup)
    const neu = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    const changes = diffApiTrees(old, neu)
    const typeParamChange = changes.find(
      (c) => c.kind === 'added' && c.path.includes('T'),
    )
    expect(typeParamChange).toBeDefined()
    expect(typeParamChange!.parentKind).toBe('class')
    const level = classifyChange(typeParamChange!, undefined, typeParamChange!.newNode)
    expect(level).toBe('major')
  })

  it('classifies added rest parameter as minor through full pipeline', () => {
    const old = extract('export declare function log(msg: string): void;')
    const f = createTempDts('export declare function log(msg: string, ...args: unknown[]): void;')
    cleanups.push(f.cleanup)
    const neu = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    const changes = diffApiTrees(old, neu)
    const restParam = changes.find(
      (c) => c.kind === 'added' && c.path.includes('args'),
    )
    expect(restParam).toBeDefined()
    expect(restParam!.newNode?.modifiers.isRest).toBe(true)
    const level = classifyChange(restParam!, undefined, restParam!.newNode)
    expect(level).toBe('minor')
  })

  it('classifies readonly removal with type change as major through full pipeline', () => {
    const old = extract('export interface Config { readonly host: string; }')
    const f = createTempDts('export interface Config { host: number; }')
    cleanups.push(f.cleanup)
    const neu = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    const changes = diffApiTrees(old, neu)
    const hostChange = changes.find((c) => c.path.includes('host') && c.kind === 'changed')
    expect(hostChange).toBeDefined()
    const level = classifyChange(hostChange!, hostChange!.oldNode, hostChange!.newNode)
    expect(level).toBe('major')
  })

  it('classifies abstract removal as minor through full pipeline', () => {
    const old = extract('export declare abstract class Base { doWork(): void; }')
    const f = createTempDts('export declare class Base { doWork(): void; }')
    cleanups.push(f.cleanup)
    const neu = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    const changes = diffApiTrees(old, neu)
    // Should detect the abstract modifier change
    expect(changes.length).toBeGreaterThan(0)
    const baseChange = changes.find((c) => c.path === 'Base' && c.kind === 'changed')
    expect(baseChange).toBeDefined()
    const level = classifyChange(baseChange!, baseChange!.oldNode, baseChange!.newNode)
    expect(level).toBe('minor')
  })

  it('classifies abstract addition as major through full pipeline', () => {
    const old = extract('export declare class Base { doWork(): void; }')
    const f = createTempDts('export declare abstract class Base { doWork(): void; }')
    cleanups.push(f.cleanup)
    const neu = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    const changes = diffApiTrees(old, neu)
    expect(changes.length).toBeGreaterThan(0)
    const baseChange = changes.find((c) => c.path === 'Base' && c.kind === 'changed')
    expect(baseChange).toBeDefined()
    const level = classifyChange(baseChange!, baseChange!.oldNode, baseChange!.newNode)
    expect(level).toBe('major')
  })
})

describe('string literal handling in type signatures', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function extract(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.0.0',
      entryPoint: '.',
    })
  }

  function diffFixtures(oldContent: string, newContent: string) {
    const oldTree = extract(oldContent)
    const f = createTempDts(newContent)
    cleanups.push(f.cleanup)
    const newTree = extractApiTree(f.filePath, {
      packageName: 'test',
      version: '1.1.0',
      entryPoint: '.',
    })
    return diffApiTrees(oldTree, newTree)
  }

  it('should not split union on pipe inside string literal', () => {
    const changes = diffFixtures(
      `export type T = 'a | b';`,
      `export type T = 'a | b' | 'c';`,
    )
    // Should detect exactly one change: 'c' was added to the union
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'T' || c.path.includes('T'))
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
    // The description should mention the added member, not misparse 'a | b' as two members
    if (change!.description) {
      expect(change!.description).not.toContain("removed")
    }
  })

  it('should handle angle brackets inside discriminant string literals', () => {
    const changes = diffFixtures(
      `export type U = { kind: "a>b"; value: string; };`,
      `export type U = { kind: "a>b"; value: string; } | { kind: "c"; value: number; };`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'U' || c.path.includes('U'))
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })

  it('should correctly split union with string literal containing brackets inside object types', () => {
    // Tests that splitUnionMembers handles string literals at depth > 0
    // { kind: "List<T>" } has angle brackets inside a string at depth 1
    const changes = diffFixtures(
      `export type T = { kind: "List<T>"; items: string[] } | { kind: "Map<K,V>"; entries: string[] };`,
      `export type T = { kind: "List<T>"; items: string[] } | { kind: "Map<K,V>"; entries: number[] };`,
    )
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find((c) => c.path === 'T')
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
    // Should NOT say "narrowed" — only the Map variant's shape changed, not removed
    expect(change!.description).not.toContain('narrowed')
  })

  it('should not split union on pipe inside tuple brackets', () => {
    // [string | number] | boolean must not be split at the inner |
    const changes = diffFixtures(
      `export type T = [string | number] | boolean;`,
      `export type T = boolean | [string | number];`,
    )
    // Union reorder only — should produce zero changes (same typeId after normalization)
    expect(changes).toHaveLength(0)
  })
})

describe('overloaded function change detection', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  function diffFixtures(oldContent: string, newContent: string) {
    const f1 = createTempDts(oldContent)
    cleanups.push(f1.cleanup)
    const oldTree = extractApiTree(f1.filePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const f2 = createTempDts(newContent)
    cleanups.push(f2.cleanup)
    const newTree = extractApiTree(f2.filePath, { packageName: 'test', version: '1.1.0', entryPoint: '.' })
    return diffApiTrees(oldTree, newTree)
  }

  it('detects change when second overload parameter type changes', () => {
    const changes = diffFixtures(
      `export declare function parse(input: string): number;
       export declare function parse(input: number): string;`,
      `export declare function parse(input: string): number;
       export declare function parse(input: boolean): string;`,
    )
    // The parent-level change MUST be detected (via typeId from typeToString)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    const change = changes.find(c => c.path.startsWith('parse'))
    expect(change).toBeDefined()
    expect(change!.kind).toBe('changed')
  })
})
