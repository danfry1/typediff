import { describe, it, expect, afterEach } from 'vitest'
import { createTempDts } from './helpers.js'
import { extractApiTree } from '../core/extractor.js'

describe('extractor robustness', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  function extract(dts: string) {
    const tmp = createTempDts(dts)
    cleanup = tmp.cleanup
    return extractApiTree(tmp.filePath, {
      packageName: 'test-pkg',
      version: '1.0.0',
      entryPoint: tmp.filePath,
    })
  }

  /** Recursively collect every node name in the tree. */
  function allNames(tree: ReturnType<typeof extractApiTree>): string[] {
    const names: string[] = []
    const walk = (n: { name: string; children: { name: string; children: unknown[] }[] }): void => {
      names.push(n.name)
      for (const c of n.children) walk(c as never)
    }
    for (const e of tree.exports) walk(e as never)
    return names
  }

  it('does not stack-overflow on a circular namespace alias', () => {
    // `export import Bar = Foo` inside Foo makes Bar an alias back to Foo — an
    // unbounded recursion without a cycle guard.
    expect(() =>
      extract(`
        declare namespace Foo {
          export import Bar = Foo;
          export const value: string;
        }
        export = Foo;
      `),
    ).not.toThrow()
  })

  it('extracts static members of a class (constructor-side API)', () => {
    const tree = extract(`
      export declare class Widget {
        instanceMethod(): void;
        static create(id: string): Widget;
        static readonly DEFAULT: number;
      }
    `)
    const names = allNames(tree)
    expect(names).toContain('static create')
    expect(names).toContain('static DEFAULT')
    // Instance members are still present and distinct from static ones.
    expect(names).toContain('instanceMethod')
  })

  it('detects removal of a static member as a change in the tree', () => {
    const withStatic = allNames(extract(`
      export declare class Widget {
        static create(id: string): Widget;
      }
    `))
    const withoutStatic = allNames(extract(`
      export declare class Widget {
        private constructor();
      }
    `))
    expect(withStatic).toContain('static create')
    expect(withoutStatic).not.toContain('static create')
  })

  it('extracts namespace exports merged onto an interface', () => {
    const tree = extract(`
      export interface Emitter {
        on(event: string): this;
      }
      export namespace Emitter {
        export type EventMap = Record<string, unknown>;
        export function listenerCount(e: Emitter): number;
      }
    `)
    const names = allNames(tree)
    // Instance member from the interface...
    expect(names).toContain('on')
    // ...and the merged namespace members, which are public API.
    expect(names).toContain('EventMap')
    expect(names).toContain('listenerCount')
  })

  it('still extracts a plain class without static members cleanly', () => {
    const tree = extract(`
      export declare class Plain {
        value: number;
        method(): string;
      }
    `)
    const names = allNames(tree)
    expect(names).toContain('value')
    expect(names).toContain('method')
    expect(names.filter((n) => n.startsWith('static '))).toHaveLength(0)
  })
})
