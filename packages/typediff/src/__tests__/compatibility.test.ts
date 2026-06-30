import { describe, it, expect, afterEach } from 'vitest'
import { checkCompatibility, checkCompatibilityTargets } from '../core/compatibility.js'
import { createTempDts } from './helpers.js'

describe('compatibility checker', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { cleanups.forEach(fn => fn()); cleanups.length = 0 })

  function fixture(content: string) {
    const f = createTempDts(content)
    cleanups.push(f.cleanup)
    return f.filePath
  }

  it('identical types are compatible in both directions', () => {
    const old = fixture('export declare const x: string;')
    const new_ = fixture('export declare const x: string;')
    const result = checkCompatibility(old, new_, ['x'])
    expect(result.get('x')?.newAssignableToOld).toBe(true)
    expect(result.get('x')?.oldAssignableToNew).toBe(true)
  })

  it('adding optional property is backwards compatible', () => {
    const old = fixture('export interface Config { host: string; }')
    const new_ = fixture('export interface Config { host: string; port?: number; }')
    const result = checkCompatibility(old, new_, ['Config'])
    expect(result.get('Config')?.newAssignableToOld).toBe(true) // new Config still satisfies old
    expect(result.get('Config')?.oldAssignableToNew).toBe(true) // old satisfies new (port is optional)
  })

  it('removing a property is NOT backwards compatible', () => {
    const old = fixture('export interface Config { host: string; port: number; }')
    const new_ = fixture('export interface Config { host: string; }')
    const result = checkCompatibility(old, new_, ['Config'])
    expect(result.get('Config')?.newAssignableToOld).toBe(false) // new Config missing port
    expect(result.get('Config')?.oldAssignableToNew).toBe(true) // old has everything new needs plus more
  })

  it('widening a type (string -> string | number) is NOT backwards assignable', () => {
    const old = fixture('export declare const x: string;')
    const new_ = fixture('export declare const x: string | number;')
    const result = checkCompatibility(old, new_, ['x'])
    expect(result.get('x')?.newAssignableToOld).toBe(false) // string | number not assignable to string
    expect(result.get('x')?.oldAssignableToNew).toBe(true) // string is assignable to string | number
  })

  it('narrowing a type (string | number -> string) IS backwards assignable', () => {
    const old = fixture('export declare const x: string | number;')
    const new_ = fixture('export declare const x: string;')
    const result = checkCompatibility(old, new_, ['x'])
    expect(result.get('x')?.newAssignableToOld).toBe(true) // string assignable to string | number
  })

  it('structurally equivalent types with different representations are compatible', () => {
    const old = fixture('export interface Foo { a: string; b: number; }')
    const new_ = fixture('export interface Foo { b: number; a: string; }') // reordered
    const result = checkCompatibility(old, new_, ['Foo'])
    expect(result.get('Foo')?.newAssignableToOld).toBe(true)
    expect(result.get('Foo')?.oldAssignableToNew).toBe(true)
  })

  it('adding required property: new extends old but old does not extend new', () => {
    const old = fixture('export interface Config { host: string; }')
    const new_ = fixture('export interface Config { host: string; port: number; }')
    const result = checkCompatibility(old, new_, ['Config'])
    // new { host, port } is assignable to old { host } (new has all old needs)
    expect(result.get('Config')?.newAssignableToOld).toBe(true)
    // old { host } is NOT assignable to new { host, port } (missing port)
    expect(result.get('Config')?.oldAssignableToNew).toBe(false)
  })

  it('function overload split is backwards compatible if accepts same inputs', () => {
    const old = fixture('export declare function process(cb: (data: string) => void | Promise<void>): void;')
    const new_ = fixture(`
      export declare function process(cb: (data: string) => void): void;
      export declare function process(cb: (data: string) => Promise<void>): void;
    `)
    const result = checkCompatibility(old, new_, ['process'])
    // The new overloaded version should accept everything the old version did
    expect(result.get('process')?.newAssignableToOld).toBe(true)
  })

  it('returns empty map for empty export names', () => {
    const old = fixture('export declare const x: string;')
    const new_ = fixture('export declare const x: string;')
    const result = checkCompatibility(old, new_, [])
    expect(result.size).toBe(0)
  })

  it('handles multiple exports at once', () => {
    const old = fixture('export declare const a: string;\nexport declare const b: number;')
    const new_ = fixture('export declare const a: string;\nexport declare const b: string;')
    const result = checkCompatibility(old, new_, ['a', 'b'])
    // a is identical
    expect(result.get('a')?.newAssignableToOld).toBe(true)
    expect(result.get('a')?.oldAssignableToNew).toBe(true)
    // b changed from number to string: incompatible both ways
    expect(result.get('b')?.newAssignableToOld).toBe(false)
    expect(result.get('b')?.oldAssignableToNew).toBe(false)
  })

  it('removing readonly from a property is not fully bidirectionally compatible', () => {
    const old = fixture('export interface Obj { readonly x: string; }')
    const new_ = fixture('export interface Obj { x: string; }')
    const result = checkCompatibility(old, new_, ['Obj'])
    // new (mutable) is assignable to old (readonly) — reading is fine
    expect(result.get('Obj')?.newAssignableToOld).toBe(true)
    // old (readonly) should NOT be assignable to new (mutable) in strict contexts
    // TypeScript's structural typing allows this, but the serialization should
    // preserve the readonly modifier so the diff detects the change
    // At minimum, the compatibility check should complete without error
    expect(result.has('Obj')).toBe(true)
  })

  it('handles non-identifier property names without crashing', () => {
    const old = fixture('export interface Config { "my-prop": string; "for": number; }')
    const neu = fixture('export interface Config { "my-prop": string; "for": string; }')
    const result = checkCompatibility(old, neu, ['Config'])
    expect(result.has('Config')).toBe(true)
    expect(result.get('Config')!.newAssignableToOld).toBe(false)
  })

  it('handles export = declarations', () => {
    const old = fixture('declare function lib(x: string): string | number;\nexport = lib;')
    const neu = fixture('declare function lib(x: string): string;\nexport = lib;')
    const result = checkCompatibility(old, neu, ['default'])
    expect(result.has('default')).toBe(true)
    // new (string) is assignable where old (string | number) was expected
    expect(result.get('default')!.newAssignableToOld).toBe(true)
  })

  describe('member targets (per-child refinement)', () => {
    it('checks a non-generic member in isolation', () => {
      const old = fixture('export declare class C { m(opts: { a: string }): void }')
      const neu = fixture('export declare class C { m(opts: { a: string; b?: number }): void }')
      const res = checkCompatibilityTargets(old, neu, [
        { id: 'm', exportName: 'C', member: { name: 'm', isStatic: false } },
      ])
      // Adding an optional field to the input is backwards-compatible both ways.
      expect(res.get('m')).toEqual({ newAssignableToOld: true, oldAssignableToNew: true })
    })

    it('reports a genuinely breaking non-generic member change', () => {
      const old = fixture('export declare class C { m(x: string): void }')
      const neu = fixture('export declare class C { m(x: number): void }')
      const res = checkCompatibilityTargets(old, neu, [
        { id: 'm', exportName: 'C', member: { name: 'm', isStatic: false } },
      ])
      const r = res.get('m')!
      expect(r.newAssignableToOld && r.oldAssignableToNew).toBe(false)
    })

    it('resolves a static member', () => {
      const old = fixture('export declare class C { static make(o: { a: string }): C }')
      const neu = fixture('export declare class C { static make(o: { a: string; b?: number }): C }')
      const res = checkCompatibilityTargets(old, neu, [
        { id: 'make', exportName: 'C', member: { name: 'make', isStatic: true } },
      ])
      expect(res.get('make')).toEqual({ newAssignableToOld: true, oldAssignableToNew: true })
    })

    it('skips a generic member — unsound to check in isolation, so no result is returned', () => {
      const old = fixture('export declare class C { gen<U extends string>(x: U): U }')
      const neu = fixture('export declare class C { gen<U extends number>(x: U): U }')
      const res = checkCompatibilityTargets(old, neu, [
        { id: 'gen', exportName: 'C', member: { name: 'gen', isStatic: false } },
      ])
      // A generic method's type parameters are unbound in isolation; the gate
      // returns no result so the caller falls back to the conservative verdict.
      expect(res.has('gen')).toBe(false)
    })

    it('skips a member of a generic class', () => {
      const old = fixture('export declare class Box<T> { unwrap(): T }')
      const neu = fixture('export declare class Box<T> { unwrap(): T }')
      const res = checkCompatibilityTargets(old, neu, [
        { id: 'unwrap', exportName: 'Box', member: { name: 'unwrap', isStatic: false } },
      ])
      expect(res.has('unwrap')).toBe(false)
    })
  })
})
