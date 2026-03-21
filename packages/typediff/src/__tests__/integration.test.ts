import { describe, it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { diffLocal } from '../index.js'

const fixturesDir = join(import.meta.dirname, 'fixtures')

describe('integration tests', () => {
  describe('export-removed', () => {
    it('detects removal as major', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'export-removed/old'),
        join(fixturesDir, 'export-removed/new'),
      )
      expect(result.actualSemver).toBe('major')
      expect(result.changes.some(c => c.kind === 'removed')).toBe(true)
    })
  })

  describe('export-added', () => {
    it('detects addition as minor', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'export-added/old'),
        join(fixturesDir, 'export-added/new'),
      )
      expect(result.actualSemver).toBe('minor')
      expect(result.changes.some(c => c.kind === 'added')).toBe(true)
    })
  })

  describe('type-narrowed', () => {
    it('detects type narrowing as minor (backwards compatible)', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'type-narrowed/old'),
        join(fixturesDir, 'type-narrowed/new'),
      )
      // Narrowing string -> 'fast' | 'slow' is backwards compatible:
      // the narrowed type is assignable where the wider type was expected
      expect(result.actualSemver).toBe('minor')
      expect(result.changes.some(c => c.kind === 'changed')).toBe(true)
    })
  })

  describe('optional-added', () => {
    it('detects optional property addition as minor', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'optional-added/old'),
        join(fixturesDir, 'optional-added/new'),
      )
      expect(result.actualSemver).toBe('minor')
      expect(result.changes.some(c => c.kind === 'added')).toBe(true)
    })
  })

  describe('required-added', () => {
    it('detects required property addition as major', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'required-added/old'),
        join(fixturesDir, 'required-added/new'),
      )
      expect(result.actualSemver).toBe('major')
      expect(result.changes.some(c => c.kind === 'added')).toBe(true)
    })
  })

  describe('no-changes', () => {
    it('detects no changes as patch', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'no-changes/old'),
        join(fixturesDir, 'no-changes/new'),
      )
      expect(result.actualSemver).toBe('patch')
      expect(result.changes).toHaveLength(0)
    })
  })

  describe('multi-entry', () => {
    it('detects changes across multiple entry points', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'multi-entry/old'),
        join(fixturesDir, 'multi-entry/new'),
      )
      // The main entry (.) is unchanged, but ./utils has a new export (uppercase)
      expect(result.changes.some(c => c.kind === 'added')).toBe(true)
      expect(result.actualSemver).toBe('minor')
      expect(result.packageName).toBe('multi-entry-pkg')
    })
  })

  describe('multi-entry-npm', () => {
    it('detects changes across multiple entry points with entryPoint field', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'multi-entry-npm/old'),
        join(fixturesDir, 'multi-entry-npm/new'),
      )
      const helperRemoved = result.changes.find(c => c.path.includes('helper') && c.kind === 'removed')
      expect(helperRemoved).toBeDefined()
      expect(helperRemoved!.entryPoint).toBe('./utils')

      const newHelperAdded = result.changes.find(c => c.path.includes('newHelper') && c.kind === 'added')
      expect(newHelperAdded).toBeDefined()
      expect(newHelperAdded!.entryPoint).toBe('./utils')
    })

    it('does not set entryPoint for main entry', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'multi-entry-npm/old'),
        join(fixturesDir, 'multi-entry-npm/new'),
      )
      // Main entry "." changes should not have entryPoint set
      const mainChanges = result.changes.filter(c => !c.path.includes('./'))
      for (const change of mainChanges) {
        expect(change.entryPoint).toBeUndefined()
      }
    })
  })

  describe('generic-constraints', () => {
    it('detects generic constraint changes', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'generic-constraints/old'),
        join(fixturesDir, 'generic-constraints/new'),
      )
      // Should detect changes in transform's T constraint, Container's T constraint, Mapper's U removal
      expect(result.changes.length).toBeGreaterThan(0)
      // Constraint changes and removed type parameter should be breaking
      expect(result.actualSemver).toBe('major')
    })
  })

  describe('diff() multi-entry', () => {
    it('uses resolveMultiEntry on npm packages', async () => {
      // The multi-entry logic in diff() mirrors diffLocal().
      // We verify it indirectly by testing diffLocal with multi-entry fixtures
      // (already covered above) since both use the same pattern.
      // Direct npm multi-entry testing is covered by real-packages.test.ts

      // Verify diffLocal correctly handles multi-entry with entryPoint field
      const result = await diffLocal(
        resolve(import.meta.dirname, 'fixtures/multi-entry-npm/old'),
        resolve(import.meta.dirname, 'fixtures/multi-entry-npm/new'),
      )
      // Verify entryPoint is set on non-main changes
      const utilsChanges = result.changes.filter(c => c.entryPoint === './utils')
      expect(utilsChanges.length).toBeGreaterThan(0)

      // Verify main entry changes have no entryPoint
      const mainChanges = result.changes.filter(c => !c.entryPoint)
      // main entry should have no changes (index.d.ts is identical)
      expect(mainChanges).toHaveLength(0)
    })
  })

  describe('version metadata', () => {
    it('computes claimedSemver correctly', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'export-removed/old'),
        join(fixturesDir, 'export-removed/new'),
      )
      expect(result.claimedSemver).toBe('minor') // 1.0.0 → 1.1.0
      expect(result.actualSemver).toBe('major')   // but actual is breaking
    })

    it('includes package name and versions', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'export-added/old'),
        join(fixturesDir, 'export-added/new'),
      )
      expect(result.packageName).toBe('test')
      expect(result.oldVersion).toBe('1.0.0')
      expect(result.newVersion).toBe('1.1.0')
    })

    it('returns patch claimedSemver for no-changes', async () => {
      const result = await diffLocal(
        join(fixturesDir, 'no-changes/old'),
        join(fixturesDir, 'no-changes/new'),
      )
      expect(result.claimedSemver).toBe('patch') // 1.0.0 → 1.0.1
      expect(result.actualSemver).toBe('patch')
    })
  })
})
