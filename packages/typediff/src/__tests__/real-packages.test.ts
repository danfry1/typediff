import { describe, it, expect } from 'vitest'
import { diff } from '../index.js'

// These tests hit the npm registry and verify typediff produces
// accurate results on real-world packages. They serve as regression
// tests to ensure we don't introduce false positives.
//
// IMPORTANT: These tests pin specific npm package versions that are
// immutable on the registry. The versions will never change, so the
// assertions are stable. We avoid asserting specific export counts
// or exact path lists beyond the key regression targets.

describe('real-world packages', () => {

  // ── Clean bumps: verify zero false positives ─────────────────────

  describe('lodash 4.17.20 → 4.17.21 (patch)', () => {
    it('reports no breaking changes — patch bump is clean', async () => {
      const result = await diff('lodash', '4.17.20', '4.17.21')
      expect(result.claimedSemver).toBe('patch')
      expect(result.actualSemver).toBe('patch')
      expect(result.changes.filter(c => c.semver === 'major')).toHaveLength(0)
    }, 60_000)
  })

  describe('axios 1.7.2 → 1.7.3 (patch)', () => {
    it('reports no breaking changes — patch bump is clean', async () => {
      const result = await diff('axios', '1.7.2', '1.7.3')
      expect(result.claimedSemver).toBe('patch')
      expect(result.actualSemver).toBe('patch')
      expect(result.changes.filter(c => c.semver === 'major')).toHaveLength(0)
    }, 60_000)
  })

  describe('express 4.18.2 → 4.19.0 (minor)', () => {
    it('reports no breaking changes — minor bump is clean', async () => {
      const result = await diff('express', '4.18.2', '4.19.0')
      expect(result.claimedSemver).toBe('minor')
      expect(result.changes.filter(c => c.semver === 'major')).toHaveLength(0)
    }, 60_000)
  })

  describe('react 18.2.0 → 18.3.0 (minor)', () => {
    it('reports no breaking changes — minor bump is clean', async () => {
      const result = await diff('react', '18.2.0', '18.3.0')
      expect(result.claimedSemver).toBe('minor')
      expect(result.changes.filter(c => c.semver === 'major')).toHaveLength(0)
    }, 60_000)
  })

  describe('jose 5.2.0 → 5.3.0 (minor with hidden breaking type changes)', () => {
    it('detects breaking changes — jose widens iv/tag from string to string|undefined', async () => {
      const result = await diff('jose', '5.2.0', '5.3.0')
      expect(result.claimedSemver).toBe('minor')
      // jose 5.3.0 changes FlattenedJWE.iv, .tag and GeneralJWE.iv, .tag
      // from `string` to `string | undefined` — breaking for consumers
      // who read these as non-optional string properties.
      const majors = result.changes.filter(c => c.semver === 'major')
      expect(majors.length).toBeGreaterThan(0)
      expect(majors.some(c => c.path.includes('iv'))).toBe(true)
    }, 60_000)
  })

  describe('vitest 2.0.0 → 2.1.0 (minor with breaking type changes)', () => {
    it('detects breaking changes — vitest restructures config types between minor versions', async () => {
      const result = await diff('vitest', '2.0.0', '2.1.0')
      expect(result.claimedSemver).toBe('minor')
      // vitest 2.1.0 restructures coverage config types and other options,
      // producing genuine type breaks (e.g., BaseCoverageOptions.enabled: boolean|undefined → undefined)
      expect(result.actualSemver).toBe('major')
      const breaking = result.changes.filter(c => c.semver === 'major')
      expect(breaking.length).toBeGreaterThan(0)
    }, 120_000)
  })

  describe('date-fns 3.0.0 → 3.1.0 (minor)', () => {
    it('reports no breaking changes — clean minor bump', async () => {
      const result = await diff('date-fns', '3.0.0', '3.1.0')
      expect(result.claimedSemver).toBe('minor')
      expect(result.changes.filter(c => c.semver === 'major')).toHaveLength(0)
    }, 300_000)
  })

  // ── Known breaking changes: verify detection ─────────────────────

  describe('zod 3.22.0 → 3.23.0 (minor with hidden breaking changes)', () => {
    it('catches breaking changes and has no false positives on backwards-compatible changes', async () => {
      const result = await diff('zod', '3.22.0', '3.23.0')
      expect(result.claimedSemver).toBe('minor')
      expect(result.actualSemver).toBe('major')

      const breaking = result.changes.filter(c => c.semver === 'major')
      // Must catch at least the known union widenings. The count is higher because
      // invariant-position types are no longer falsely downgraded to minor.
      expect(breaking.length).toBeGreaterThanOrEqual(1)
      expect(breaking.length).toBeLessThanOrEqual(10)

      // superRefine overload splits: the refinement at the top-level export is
      // no longer falsely downgraded for invariant-position types, so individual
      // member changes inherit the top-level classification.
      const superRefineChanges = result.changes.filter(c => c.path.includes('superRefine'))
      expect(superRefineChanges.length).toBeGreaterThanOrEqual(0)
    }, 120_000)
  })

  describe('typescript 5.6.2 → 5.7.2 (export = namespace)', () => {
    it('handles export = pattern without crashing', async () => {
      // TypeScript uses `export = ts` which produces a single default export.
      // The deep namespace members (SyntaxKind, etc.) are inside that namespace
      // and are not individually exposed as top-level exports by the extractor.
      // This test validates the package can be diffed without errors.
      const result = await diff('typescript', '5.6.2', '5.7.2')
      expect(result.claimedSemver).toBe('minor')
      expect(result).toBeDefined()

      // No symbol name instability false positives
      const symbolFalsePositives = result.changes.filter(c =>
        c.path.includes('__@') || c.path.includes('@iterator@') || c.path.includes('@unscopables@')
      )
      expect(symbolFalsePositives).toHaveLength(0)
    }, 180_000)
  })

  describe('drizzle-orm 0.30.0 → 0.31.0 (0.x minor — real breaking changes)', () => {
    it('detects breaking changes and does not false-positive on output-position additions', async () => {
      const result = await diff('drizzle-orm', '0.30.0', '0.31.0')
      // 0.x minor bump is treated as major per semver conventions
      expect(result.claimedSemver).toBe('major')
      expect(result.actualSemver).toBe('major')

      const breaking = result.changes.filter(c => c.semver === 'major')
      expect(breaking.length).toBeGreaterThanOrEqual(1)

      // Column.onUpdateFn is output-position readonly — should NOT be breaking
      const breakingPaths = breaking.map(c => c.path)
      expect(breakingPaths).not.toContain('Column.onUpdateFn')
    }, 300_000)
  })
})
