import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Change } from '../core/types.js'
import { aggregateSemver, applyFilters, refineWithCompatibility } from '../core/refine.js'

function makeChange(overrides: Partial<Change> & { path: string }): Change {
  return {
    kind: 'changed',
    semver: 'major',
    description: 'test change',
    ...overrides,
  }
}

function createDtsFile(content: string): { filePath: string; cleanup: () => void } {
  const dir = join(tmpdir(), `typediff-refine-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'index.d.ts')
  writeFileSync(filePath, content)
  return { filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('refineWithCompatibility', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const fn of cleanups) fn()
    cleanups.length = 0
  })

  it('downgrades bidirectionally-compatible change to patch', () => {
    // Reordering properties is structurally equivalent
    const oldDts = createDtsFile('export interface Config { a: string; b: number; }')
    const newDts = createDtsFile('export interface Config { b: number; a: string; }')
    cleanups.push(oldDts.cleanup, newDts.cleanup)

    const changes: Change[] = [{
      kind: 'changed',
      path: 'Config',
      semver: 'major',
      description: 'test',
      oldNode: {
        name: 'Config', path: 'Config', kind: 'interface',
        signature: '{ a: string; b: number }', children: [], typeId: 'a',
        position: 'invariant', modifiers: {},
      },
      newNode: {
        name: 'Config', path: 'Config', kind: 'interface',
        signature: '{ b: number; a: string }', children: [], typeId: 'b',
        position: 'invariant', modifiers: {},
      },
    }]
    refineWithCompatibility(changes, oldDts.filePath, newDts.filePath)
    expect(changes[0].semver).toBe('patch')
  })

  it('downgrades output-position one-way-compatible change to minor', () => {
    // New type is a subtype (narrower) of old — safe for output position
    const oldDts = createDtsFile('export declare function foo(): string | number;')
    const newDts = createDtsFile('export declare function foo(): string;')
    cleanups.push(oldDts.cleanup, newDts.cleanup)

    const changes: Change[] = [{
      kind: 'changed',
      path: 'foo.return',
      semver: 'major',
      description: 'test',
      oldNode: {
        name: 'return', path: 'foo.return', kind: 'return-type',
        signature: 'string | number', children: [], typeId: 'a',
        position: 'output', modifiers: {},
      },
      newNode: {
        name: 'return', path: 'foo.return', kind: 'return-type',
        signature: 'string', children: [], typeId: 'b',
        position: 'output', modifiers: {},
      },
    }]
    refineWithCompatibility(changes, oldDts.filePath, newDts.filePath)
    expect(changes[0].semver).toBe('minor')
  })

  it('does not downgrade invariant-position one-way-compatible change', () => {
    // Narrowing in invariant position is still breaking for producers
    const oldDts = createDtsFile('export interface Config { value: string | number; }')
    const newDts = createDtsFile('export interface Config { value: string; }')
    cleanups.push(oldDts.cleanup, newDts.cleanup)

    const changes: Change[] = [{
      kind: 'changed',
      path: 'Config.value',
      semver: 'major',
      description: 'test',
      oldNode: {
        name: 'value', path: 'Config.value', kind: 'property',
        signature: 'string | number', children: [], typeId: 'a',
        position: 'invariant', modifiers: {},
      },
      newNode: {
        name: 'value', path: 'Config.value', kind: 'property',
        signature: 'string', children: [], typeId: 'b',
        position: 'invariant', modifiers: {},
      },
    }]
    refineWithCompatibility(changes, oldDts.filePath, newDts.filePath)
    expect(changes[0].semver).toBe('major')
  })

  it('does not refine added or removed changes', () => {
    const oldDts = createDtsFile('export declare const a: string; export declare const b: number;')
    const newDts = createDtsFile('export declare const a: string;')
    cleanups.push(oldDts.cleanup, newDts.cleanup)

    const changes: Change[] = [
      { kind: 'removed', path: 'b', semver: 'major', description: 'removed' },
      {
        kind: 'changed', path: 'a', semver: 'major', description: 'changed',
        oldNode: { name: 'a', path: 'a', kind: 'const', signature: 'string', children: [], typeId: 'x', position: 'output', modifiers: {} },
        newNode: { name: 'a', path: 'a', kind: 'const', signature: 'string', children: [], typeId: 'x', position: 'output', modifiers: {} },
      },
    ]
    refineWithCompatibility(changes, oldDts.filePath, newDts.filePath)
    // Removed change stays major — refineWithCompatibility does not touch it
    expect(changes[0].semver).toBe('major')
  })
})

describe('aggregateSemver', () => {
  it('returns patch for empty changes', () => {
    expect(aggregateSemver([])).toBe('patch')
  })

  it('returns the highest severity', () => {
    const changes: Change[] = [
      makeChange({ path: 'a', semver: 'patch' }),
      makeChange({ path: 'b', semver: 'minor' }),
      makeChange({ path: 'c', semver: 'patch' }),
    ]
    expect(aggregateSemver(changes)).toBe('minor')
  })

  it('returns major when any change is major', () => {
    const changes: Change[] = [
      makeChange({ path: 'a', semver: 'patch' }),
      makeChange({ path: 'b', semver: 'major' }),
    ]
    expect(aggregateSemver(changes)).toBe('major')
  })

  it('returns patch when all changes are patch', () => {
    const changes: Change[] = [
      makeChange({ path: 'a', semver: 'patch' }),
      makeChange({ path: 'b', semver: 'patch' }),
    ]
    expect(aggregateSemver(changes)).toBe('patch')
  })
})

describe('applyFilters', () => {
  const changes: Change[] = [
    makeChange({ path: 'Config.host', semver: 'major' }),
    makeChange({ path: 'Config.port', semver: 'minor' }),
    makeChange({ path: 'internal.secret', semver: 'major' }),
    makeChange({ path: 'createClient', semver: 'patch', kind: 'added' }),
  ]

  it('returns all changes when no options', () => {
    expect(applyFilters(changes)).toHaveLength(4)
  })

  it('returns all changes when empty options', () => {
    expect(applyFilters(changes, {})).toHaveLength(4)
  })

  it('filters by ignore glob pattern', () => {
    const filtered = applyFilters(changes, { ignore: ['internal.*'] })
    expect(filtered).toHaveLength(3)
    expect(filtered.every(c => !c.path.startsWith('internal'))).toBe(true)
  })

  it('supports multiple ignore patterns', () => {
    const filtered = applyFilters(changes, { ignore: ['internal.*', 'Config.host'] })
    expect(filtered).toHaveLength(2)
  })

  it('filters by severity threshold (major)', () => {
    const filtered = applyFilters(changes, { severity: 'major' })
    expect(filtered).toHaveLength(2)
    expect(filtered.every(c => c.semver === 'major')).toBe(true)
  })

  it('filters by severity threshold (minor)', () => {
    const filtered = applyFilters(changes, { severity: 'minor' })
    expect(filtered).toHaveLength(3)
    expect(filtered.every(c => c.semver !== 'patch')).toBe(true)
  })

  it('combines ignore and severity filters', () => {
    const filtered = applyFilters(changes, { ignore: ['internal.*'], severity: 'major' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].path).toBe('Config.host')
  })

  it('filters out underscore-prefixed members by default', () => {
    const withInternals: Change[] = [
      makeChange({ path: 'Config.host', semver: 'major' }),
      makeChange({ path: 'ZodString._regex.validation', semver: 'major' }),
      makeChange({ path: '_internalHelper', semver: 'minor' }),
      makeChange({ path: 'createClient', semver: 'patch', kind: 'added' }),
    ]
    const filtered = applyFilters(withInternals)
    expect(filtered).toHaveLength(2)
    expect(filtered.map(c => c.path)).toEqual(['Config.host', 'createClient'])
  })

  it('includes underscore-prefixed members when includeInternals is true', () => {
    const withInternals: Change[] = [
      makeChange({ path: 'Config.host', semver: 'major' }),
      makeChange({ path: 'ZodString._regex.validation', semver: 'major' }),
      makeChange({ path: '_internalHelper', semver: 'minor' }),
    ]
    const filtered = applyFilters(withInternals, { includeInternals: true })
    expect(filtered).toHaveLength(3)
  })

  it('filters underscore-prefixed exports in multi-entry paths with : separator', () => {
    const multiEntryChanges: Change[] = [
      makeChange({ path: './utils:_privateHelper', semver: 'major' }),
      makeChange({ path: './utils:publicFn', semver: 'minor' }),
      makeChange({ path: '_topLevelInternal', semver: 'major' }),
      makeChange({ path: 'Config._hidden', semver: 'major' }),
    ]
    const filtered = applyFilters(multiEntryChanges)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].path).toBe('./utils:publicFn')
  })
})
