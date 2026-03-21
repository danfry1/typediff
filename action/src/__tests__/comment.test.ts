import { describe, it, expect } from 'vitest'
import { formatComment, getCommentMarker } from '../comment.js'
import { shouldFail } from '../check.js'
import type { ChangeSet, SemverLevel } from 'typediff'

function makeChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    packageName: 'test-pkg',
    oldVersion: '1.0.0',
    newVersion: '1.1.0',
    changes: [],
    actualSemver: 'minor',
    claimedSemver: 'minor',
    ...overrides,
  }
}

describe('formatComment', () => {
  it('renders verified package with marker', () => {
    const results: ChangeSet[] = [
      makeChangeSet({
        packageName: 'my-lib',
        oldVersion: '2.0.0',
        newVersion: '2.1.0',
        actualSemver: 'minor',
        claimedSemver: 'minor',
      }),
    ]

    const comment = formatComment(results)

    expect(comment).toContain('<!-- typediff-verify -->')
    expect(comment).toContain('Verified')
    expect(comment).toContain('my-lib')
  })

  it('renders mismatched package with change details', () => {
    const results: ChangeSet[] = [
      makeChangeSet({
        packageName: 'breaking-lib',
        oldVersion: '1.0.0',
        newVersion: '1.1.0',
        actualSemver: 'major',
        claimedSemver: 'minor',
        changes: [
          {
            kind: 'removed',
            path: 'SomeInterface.method',
            semver: 'major',
            description: 'Removed method from public interface',
          },
        ],
      }),
    ]

    const comment = formatComment(results)

    expect(comment).toContain('<!-- typediff-verify -->')
    expect(comment).toContain('Mismatch')
    expect(comment).toContain('breaking-lib')
    expect(comment).toContain('Removed method from public interface')
  })

  it('escapes pipe characters in change descriptions for markdown tables', () => {
    const results: ChangeSet[] = [
      makeChangeSet({
        packageName: 'pipe-lib',
        oldVersion: '1.0.0',
        newVersion: '2.0.0',
        actualSemver: 'major',
        claimedSemver: 'minor',
        changes: [
          {
            kind: 'changed',
            path: 'MyType',
            semver: 'major',
            description: "Type changed from 'a' | 'b' to 'c'",
          },
        ],
      }),
    ]

    const comment = formatComment(results)

    // The pipe in the description should be escaped so it doesn't break the markdown table
    expect(comment).toContain("'a' \\| 'b'")
    expect(comment).not.toMatch(/\| 'a' \| 'b' \|/)
  })

  it('renders mixed results with both verified and mismatched', () => {
    const results: ChangeSet[] = [
      makeChangeSet({
        packageName: 'good-lib',
        actualSemver: 'minor',
        claimedSemver: 'minor',
      }),
      makeChangeSet({
        packageName: 'bad-lib',
        actualSemver: 'major',
        claimedSemver: 'patch',
        changes: [
          {
            kind: 'changed',
            path: 'Config.timeout',
            semver: 'major',
            description: 'Type changed from number to string',
          },
        ],
      }),
    ]

    const comment = formatComment(results)

    expect(comment).toContain('good-lib')
    expect(comment).toContain('bad-lib')
    expect(comment).toContain('Verified')
    expect(comment).toContain('Mismatch')
  })
})

describe('getCommentMarker', () => {
  it('returns the hidden HTML comment marker', () => {
    expect(getCommentMarker()).toBe('<!-- typediff-verify -->')
  })
})

describe('shouldFail', () => {
  it('returns false when failOn is never', () => {
    const results: ChangeSet[] = [
      makeChangeSet({ actualSemver: 'major', claimedSemver: 'patch' }),
    ]
    expect(shouldFail(results, 'never')).toBe(false)
  })

  it('returns true when actual exceeds claimed and meets threshold', () => {
    const results: ChangeSet[] = [
      makeChangeSet({ actualSemver: 'major', claimedSemver: 'minor' }),
    ]
    expect(shouldFail(results, 'major')).toBe(true)
  })

  it('returns false when actual matches claimed', () => {
    const results: ChangeSet[] = [
      makeChangeSet({ actualSemver: 'minor', claimedSemver: 'minor' }),
    ]
    expect(shouldFail(results, 'major')).toBe(false)
  })

  it('returns false when claimedSemver is missing', () => {
    const results: ChangeSet[] = [
      makeChangeSet({ actualSemver: 'major', claimedSemver: undefined }),
    ]
    expect(shouldFail(results, 'major')).toBe(false)
  })

  it('returns true for minor threshold when actual is minor but claimed is patch', () => {
    const results: ChangeSet[] = [
      makeChangeSet({ actualSemver: 'minor', claimedSemver: 'patch' }),
    ]
    expect(shouldFail(results, 'minor')).toBe(true)
  })

  it('returns false for major threshold when actual is minor but claimed is patch', () => {
    const results: ChangeSet[] = [
      makeChangeSet({ actualSemver: 'minor', claimedSemver: 'patch' }),
    ]
    expect(shouldFail(results, 'major')).toBe(false)
  })
})
