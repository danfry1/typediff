import { describe, it, expect, afterEach } from 'vitest'
import { resolve, join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createSnapshot, loadSnapshot, synthesizeDtsFromTree } from '../core/snapshot.js'
import { extractApiTree } from '../core/extractor.js'
import { createTempDts } from './helpers.js'
import { runCompare } from '../cli/commands/compare.js'

describe('snapshot', () => {
  it('creates a snapshot from a fixture', () => {
    const fixturePath = resolve(__dirname, 'fixtures/export-added/new')
    const snapshot = createSnapshot(fixturePath)
    expect(snapshot.snapshotVersion).toBe(1)
    expect(snapshot.typediffVersion).toBeDefined()
    expect(snapshot.packageName).toBeDefined()
    expect(snapshot.entryPoints['.']).toBeDefined()
    expect(snapshot.entryPoints['.'].exports.length).toBeGreaterThan(0)
  })

  it('stores entry point keys, not absolute file paths, in ApiTree.entryPoint', () => {
    const fixturePath = resolve(__dirname, 'fixtures/export-added/new')
    const snapshot = createSnapshot(fixturePath)
    const tree = snapshot.entryPoints['.']
    expect(tree.entryPoint).toBe('.')
    expect(tree.entryPoint).not.toContain('/')
  })

  it('round-trips through JSON serialization', () => {
    const fixturePath = resolve(__dirname, 'fixtures/export-added/new')
    const snapshot = createSnapshot(fixturePath)
    const tmpFile = join(tmpdir(), `typediff-test-${randomUUID()}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(snapshot))
      const loaded = loadSnapshot(tmpFile)
      expect(loaded.packageName).toBe(snapshot.packageName)
      expect(loaded.packageVersion).toBe(snapshot.packageVersion)
      const origExports = snapshot.entryPoints['.'].exports
      const loadedExports = loaded.entryPoints['.'].exports
      expect(loadedExports.length).toBe(origExports.length)
      // Verify individual export nodes survived round-trip
      for (let i = 0; i < origExports.length; i++) {
        expect(loadedExports[i].name).toBe(origExports[i].name)
        expect(loadedExports[i].kind).toBe(origExports[i].kind)
        expect(loadedExports[i].signature).toBe(origExports[i].signature)
        expect(loadedExports[i].typeId).toBe(origExports[i].typeId)
      }
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('throws on invalid snapshot version', () => {
    const tmpFile = join(tmpdir(), `typediff-bad-${randomUUID()}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify({ snapshotVersion: 99 }))
      expect(() => loadSnapshot(tmpFile)).toThrow('Unsupported snapshot version')
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('throws on snapshot with missing entryPoints', () => {
    const dir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'bad-snapshot.json')
    try {
      writeFileSync(filePath, JSON.stringify({
        snapshotVersion: 1,
        typediffVersion: '0.2.0',
        packageName: 'test',
        packageVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
      }))
      expect(() => loadSnapshot(filePath)).toThrow(/entryPoints/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws on snapshot with non-object entryPoints', () => {
    const dir = join(tmpdir(), `typediff-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'bad-snapshot.json')
    try {
      writeFileSync(filePath, JSON.stringify({
        snapshotVersion: 1,
        typediffVersion: '0.2.0',
        packageName: 'test',
        packageVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        entryPoints: 'not-an-object',
      }))
      expect(() => loadSnapshot(filePath)).toThrow(/entryPoints/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws on entry point with malformed exports field', () => {
    const dir = join(tmpdir(), `typediff-snapshot-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'snapshot.json')
    try {
      writeFileSync(filePath, JSON.stringify({
        snapshotVersion: 1,
        typediffVersion: '0.0.0',
        packageName: 'test',
        packageVersion: '1.0.0',
        entryPoints: { '.': { exports: 'not-an-array', packageName: 'test', version: '1.0.0', entryPoint: '.' } },
      }))
      expect(() => loadSnapshot(filePath)).toThrow(/malformed exports/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws on export nodes missing required fields', () => {
    const dir = join(tmpdir(), `typediff-snapshot-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'snapshot.json')
    try {
      writeFileSync(filePath, JSON.stringify({
        snapshotVersion: 1,
        typediffVersion: '0.0.0',
        packageName: 'test',
        packageVersion: '1.0.0',
        entryPoints: {
          '.': {
            exports: [{}],
            packageName: 'test',
            version: '1.0.0',
            entryPoint: '.',
          },
        },
      }))
      expect(() => loadSnapshot(filePath)).toThrow(/malformed export/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws on export nodes missing children or modifiers', () => {
    const dir = join(tmpdir(), `typediff-snapshot-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'snapshot.json')
    try {
      // Node has name/kind/signature but missing children and modifiers
      writeFileSync(filePath, JSON.stringify({
        snapshotVersion: 1,
        typediffVersion: '0.0.0',
        packageName: 'test',
        packageVersion: '1.0.0',
        entryPoints: {
          '.': {
            exports: [{
              name: 'foo',
              kind: 'const',
              signature: 'string',
              path: 'foo',
              typeId: 'abc',
              position: 'output',
              // missing: children, modifiers
            }],
            packageName: 'test',
            version: '1.0.0',
            entryPoint: '.',
          },
        },
      }))
      expect(() => loadSnapshot(filePath)).toThrow(/malformed export/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws on empty entryPoints object', () => {
    const dir = join(tmpdir(), `typediff-snapshot-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'snapshot.json')
    try {
      writeFileSync(filePath, JSON.stringify({
        snapshotVersion: 1,
        typediffVersion: '0.0.0',
        packageName: 'test',
        packageVersion: '1.0.0',
        entryPoints: {},
      }))
      expect(() => loadSnapshot(filePath)).toThrow(/at least one entry point/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not warn on missing typediffVersion', () => {
    const dir = join(tmpdir(), `typediff-snapshot-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'snapshot.json')
    try {
      const validNode = {
        name: 'x', kind: 'const', signature: 'number', path: 'x',
        typeId: 'a', position: 'output', children: [], modifiers: {},
      }
      writeFileSync(filePath, JSON.stringify({
        snapshotVersion: 1,
        packageName: 'test',
        packageVersion: '1.0.0',
        entryPoints: { '.': { exports: [validNode], packageName: 'test', version: '1.0.0', entryPoint: '.' } },
        // no typediffVersion field
      }))
      const warnings: string[] = []
      loadSnapshot(filePath, (msg) => warnings.push(msg))
      // Should NOT warn about version mismatch when field is absent
      expect(warnings).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('compare', () => {
  it('detects changes between a snapshot and a local path', async () => {
    const oldFixture = resolve(import.meta.dirname, 'fixtures/export-removed/old')
    const newFixture = resolve(import.meta.dirname, 'fixtures/export-removed/new')
    const snapshot = createSnapshot(oldFixture)
    const tmpFile = join(tmpdir(), `typediff-compare-test-${randomUUID()}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(snapshot))
      const result = await runCompare(tmpFile, newFixture, {})
      expect(result.changes.length).toBeGreaterThan(0)
      // Should detect the removal as major
      const removed = result.changes.find(c => c.kind === 'removed')
      expect(removed).toBeDefined()
      expect(result.actualSemver).toBe('major')
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('returns no changes when comparing identical packages', async () => {
    const fixture = resolve(import.meta.dirname, 'fixtures/no-changes/old')
    const snapshot = createSnapshot(fixture)
    const tmpFile = join(tmpdir(), `typediff-compare-nochange-${randomUUID()}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(snapshot))
      const result = await runCompare(tmpFile, fixture, {})
      expect(result.changes).toHaveLength(0)
      expect(result.actualSemver).toBe('patch')
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('detects added exports between snapshot and new version', async () => {
    const oldFixture = resolve(import.meta.dirname, 'fixtures/export-added/old')
    const newFixture = resolve(import.meta.dirname, 'fixtures/export-added/new')
    const snapshot = createSnapshot(oldFixture)
    const tmpFile = join(tmpdir(), `typediff-compare-added-${randomUUID()}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(snapshot))
      const result = await runCompare(tmpFile, newFixture, {})
      const added = result.changes.find(c => c.kind === 'added')
      expect(added).toBeDefined()
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('snapshot compare downgrades structurally-equivalent type changes to patch', async () => {
    // Both old and new have identical types — any "changed" should be downgraded
    const fixture = resolve(import.meta.dirname, 'fixtures/type-equivalent/old')
    const newFixture = resolve(import.meta.dirname, 'fixtures/type-equivalent/new')
    const snapshot = createSnapshot(fixture)
    const tmpFile = join(tmpdir(), `typediff-compare-equiv-${randomUUID()}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(snapshot))
      const result = await runCompare(tmpFile, newFixture, {})
      // No breaking changes should exist since types are identical
      const breaking = result.changes.filter(c => c.semver === 'major')
      expect(breaking).toHaveLength(0)
      expect(result.actualSemver).toBe('patch')
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('snapshot compare correctly classifies narrowed type changes', async () => {
    // type-narrowed: string → 'fast' | 'slow' (narrowing is backwards-compatible for output)
    const oldFixture = resolve(import.meta.dirname, 'fixtures/type-narrowed/old')
    const newFixture = resolve(import.meta.dirname, 'fixtures/type-narrowed/new')
    const snapshot = createSnapshot(oldFixture)
    const tmpFile = join(tmpdir(), `typediff-compare-narrow-${randomUUID()}.json`)
    try {
      writeFileSync(tmpFile, JSON.stringify(snapshot))
      const result = await runCompare(tmpFile, newFixture, {})
      // The narrowed type (string → 'fast' | 'slow') should be detected as a change
      expect(result.changes.length).toBeGreaterThan(0)
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })
})

describe('synthesizeDtsFromTree', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { cleanups.forEach(fn => fn()); cleanups.length = 0 })

  it('synthesizes a valid .d.ts from a snapshot tree', () => {
    const fixture = resolve(import.meta.dirname, 'fixtures/export-added/new')
    const snapshot = createSnapshot(fixture)
    const tree = snapshot.entryPoints['.']
    expect(tree).toBeDefined()

    const { dtsPath, cleanup } = synthesizeDtsFromTree(tree)
    try {
      const content = readFileSync(dtsPath, 'utf-8')
      // Should contain export declarations
      expect(content).toContain('export')
      // Should reference the exported names
      expect(content).toContain('a')
      expect(content).toContain('b')
    } finally {
      cleanup()
    }
  })

  it('cleanup removes the temp directory', () => {
    const fixture = resolve(import.meta.dirname, 'fixtures/export-added/new')
    const snapshot = createSnapshot(fixture)
    const tree = snapshot.entryPoints['.']

    const { dtsPath, cleanup } = synthesizeDtsFromTree(tree)
    cleanup()
    expect(existsSync(dtsPath)).toBe(false)
  })

  it('synthesizes default export correctly', () => {
    const f = createTempDts('export default function main(): void;')
    cleanups.push(f.cleanup)
    const tree = extractApiTree(f.filePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const { dtsPath, cleanup } = synthesizeDtsFromTree(tree)
    cleanups.push(cleanup)
    const content = readFileSync(dtsPath, 'utf-8')
    expect(content).toContain('export default')
    expect(content).not.toContain('export declare function default')
  })

  it('synthesizes call signature with callback parameter correctly', () => {
    const f = createTempDts(`
      export interface EventEmitter {
        on(event: string, listener: (data: string) => void): void;
        (fn: (x: string) => void): string;
      }
    `)
    cleanups.push(f.cleanup)
    const tree = extractApiTree(f.filePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const { dtsPath, cleanup } = synthesizeDtsFromTree(tree)
    cleanups.push(cleanup)
    const content = readFileSync(dtsPath, 'utf-8')
    // The call signature should NOT corrupt the inner arrow:
    // (fn: (x: string) => void): string — NOT (fn: (x: string): void) => string
    expect(content).not.toContain('(x: string): void) => string')
  })

  it('synthesizes generic class methods with type parameters', () => {
    const f = createTempDts(`
      export declare class Container {
        get<T>(key: string): T;
        set<T>(key: string, value: T): void;
      }
    `)
    cleanups.push(f.cleanup)
    const tree = extractApiTree(f.filePath, { packageName: 'test', version: '1.0.0', entryPoint: '.' })
    const { dtsPath, cleanup } = synthesizeDtsFromTree(tree)
    cleanups.push(cleanup)
    const content = readFileSync(dtsPath, 'utf-8')
    // Methods should include <T> type parameters
    expect(content).toContain('<T>')
  })
})
