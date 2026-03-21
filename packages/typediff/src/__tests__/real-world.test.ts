import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { diffLocal } from '../index.js'
import { extractApiTree } from '../core/extractor.js'
import { createTempDts } from './helpers.js'

let tempDirs: string[] = []

function createPkg(dts: string, version = '1.0.0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'typediff-rw-test-'))
  tempDirs.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'test-pkg',
      version,
      types: './index.d.ts',
    }),
  )
  writeFileSync(join(dir, 'index.d.ts'), dts)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('real-world regression tests', () => {
  describe('zod SafeParseSuccess pattern: adding optional property to interface is NOT breaking', () => {
    it('should be patch (structurally equivalent)', async () => {
      const oldDir = createPkg(`
        export interface SafeParseSuccess<Output> {
          success: true;
          data: Output;
        }
      `)
      const newDir = createPkg(`
        export interface SafeParseSuccess<Output> {
          success: true;
          data: Output;
          error?: undefined;
        }
      `)

      const result = await diffLocal(oldDir, newDir)

      // Adding an optional property that is typed as undefined is structurally
      // equivalent -- { success: true; data: T } is assignable to
      // { success: true; data: T; error?: undefined } and vice versa.
      expect(result.actualSemver).not.toBe('major')
    })
  })

  describe('zod superRefine pattern: overload split is NOT breaking', () => {
    it('should not be major when splitting union param into overloads', async () => {
      const oldDir = createPkg(`
        export declare function process(cb: (x: string) => void | Promise<void>): void;
      `)
      const newDir = createPkg(`
        export declare function process(cb: (x: string) => void): void;
        export declare function process(cb: (x: string) => Promise<void>): void;
      `)

      const result = await diffLocal(oldDir, newDir)

      // Splitting a union-returning callback into overloads should not be
      // breaking -- callers passing either form will still match an overload.
      expect(result.actualSemver).not.toBe('major')
    })
  })

  describe('zod ZodStringCheck pattern: discriminated union widening IS breaking', () => {
    it('should be major when adding new discriminated union members', async () => {
      const oldDir = createPkg(`
        export type Check = { kind: 'min'; value: number } | { kind: 'max'; value: number };
      `)
      const newDir = createPkg(`
        export type Check = { kind: 'min'; value: number } | { kind: 'max'; value: number } | { kind: 'length'; value: number };
      `)

      const result = await diffLocal(oldDir, newDir)

      // Adding new members to a discriminated union is breaking because
      // consumers with exhaustive switches will fail at compile time.
      expect(result.actualSemver).toBe('major')
    })
  })

  describe('zod StringValidation pattern: adding new string union members IS breaking in output position', () => {
    it('should be major when widening a string union type', async () => {
      const oldDir = createPkg(`
        export type Validation = 'email' | 'url' | 'uuid';
      `)
      const newDir = createPkg(`
        export type Validation = 'email' | 'url' | 'uuid' | 'nanoid' | 'base64';
      `)

      const result = await diffLocal(oldDir, newDir)

      // Adding new members to a string union type is breaking because
      // consumers pattern-matching on the union will have unhandled cases.
      expect(result.actualSemver).toBe('major')
    })
  })

  describe('Symbol.iterator names should be stable across compiler invocations', () => {
    it('should normalize __@symbol@NNN names so they match across extractions', () => {
      const tmp1 = createTempDts(`
        export interface MyIterable<T> {
          [Symbol.iterator](): Iterator<T>;
        }
      `)
      const tmp2 = createTempDts(`
        export interface MyIterable<T> {
          [Symbol.iterator](): Iterator<T>;
        }
      `)

      const tree1 = extractApiTree(tmp1.filePath, {
        packageName: 'test-pkg',
        version: '1.0.0',
        entryPoint: tmp1.filePath,
      })
      const tree2 = extractApiTree(tmp2.filePath, {
        packageName: 'test-pkg',
        version: '2.0.0',
        entryPoint: tmp2.filePath,
      })

      tmp1.cleanup()
      tmp2.cleanup()

      const iface1 = tree1.exports[0]
      const iface2 = tree2.exports[0]

      // Both extractions should produce the same child names
      const names1 = iface1.children.map((c) => c.name).sort()
      const names2 = iface2.children.map((c) => c.name).sort()
      expect(names1).toEqual(names2)

      // The iterator child should have the stable normalized name
      const iterChild1 = iface1.children.find((c) => c.name.includes('iterator'))
      expect(iterChild1).toBeDefined()
      expect(iterChild1!.name).toBe('[Symbol.iterator]')

      // No child should have the raw __@...@NNN form
      for (const child of iface1.children) {
        expect(child.name).not.toMatch(/__@\w+@\d+/)
      }
    })

    it('should not produce false positive diffs for Symbol properties', async () => {
      const oldDir = createPkg(`
        export interface MyIterable<T> {
          [Symbol.iterator](): Iterator<T>;
          length: number;
        }
      `)
      const newDir = createPkg(`
        export interface MyIterable<T> {
          [Symbol.iterator](): Iterator<T>;
          length: number;
        }
      `)

      const result = await diffLocal(oldDir, newDir)

      // Identical interfaces should produce no changes, even with Symbol members
      expect(result.changes).toHaveLength(0)
      expect(result.actualSemver).toBe('patch')
    })
  })
})
