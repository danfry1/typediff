import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangeSet } from 'typediff'

// --- Mocks ---

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}))

vi.mock('@actions/github', () => ({
  getOctokit: vi.fn(),
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
}))

vi.mock('typediff', () => ({
  diff: vi.fn(),
  SEVERITY_ORDER: { patch: 0, minor: 1, major: 2 },
}))

vi.mock('minimatch', () => ({
  minimatch: vi.fn((name: string, pattern: string) => {
    // Simple glob: support exact match and wildcard prefix
    if (pattern === name) return true
    if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true
    return false
  }),
}))

// --- Imports (after mocks) ---

import * as core from '@actions/core'
import * as github from '@actions/github'
import { diff } from 'typediff'
import { run, chunk } from '../index.js'

// --- Helpers ---

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

function setupDefaults() {
  // Default inputs
  vi.mocked(core.getInput).mockImplementation((name: string) => {
    switch (name) {
      case 'github-token':
        return 'fake-token'
      case 'severity':
        return 'minor'
      case 'fail-on':
        return 'major'
      case 'ignore':
        return ''
      default:
        return ''
    }
  })

  // Default PR context
  Object.assign(github.context, {
    payload: { pull_request: { number: 42 } },
    repo: { owner: 'test-owner', repo: 'test-repo' },
  })

  // Default octokit mock
  const mockListFiles = vi.fn().mockResolvedValue({
    data: [
      {
        filename: 'package-lock.json',
        patch: [
          'diff --git a/package-lock.json b/package-lock.json',
          '@@ -100,7 +100,7 @@',
          '     "node_modules/test-pkg": {',
          '-      "version": "1.0.0",',
          '+      "version": "1.1.0",',
          '       "resolved": "https://registry.npmjs.org/test-pkg/-/test-pkg-1.1.0.tgz",',
        ].join('\n'),
      },
    ],
  })

  const mockListComments = vi.fn().mockResolvedValue({ data: [] })

  const mockOctokit = {
    paginate: vi.fn(async (method: any, params: any) => {
      const result = await method(params)
      return result.data
    }),
    rest: {
      pulls: {
        listFiles: mockListFiles,
      },
      issues: {
        listComments: mockListComments,
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
      },
    },
  }

  vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any)

  // Default diff result — verified (actual matches claimed)
  vi.mocked(diff).mockResolvedValue(makeChangeSet())

  return mockOctokit
}

// --- Tests ---

describe('run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls setFailed for invalid severity input', async () => {
    setupDefaults()
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === 'severity') return 'invalid'
      if (name === 'github-token') return 'fake-token'
      if (name === 'fail-on') return 'major'
      return ''
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'Invalid severity "invalid". Must be major, minor, or patch.',
    )
  })

  it('calls setFailed for invalid fail-on input', async () => {
    setupDefaults()
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === 'fail-on') return 'always'
      if (name === 'github-token') return 'fake-token'
      if (name === 'severity') return 'minor'
      return ''
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'Invalid fail-on "always". Must be major, minor, or never.',
    )
  })

  it('skips when not a PR event', async () => {
    setupDefaults()
    // Override context to have no pull_request
    Object.assign(github.context, {
      payload: {},
      repo: { owner: 'test-owner', repo: 'test-repo' },
    })

    await run()

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Not a pull request event'),
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('skips when no lockfile in PR files', async () => {
    const mockOctokit = setupDefaults()
    mockOctokit.rest.pulls.listFiles.mockResolvedValue({
      data: [
        { filename: 'src/app.ts', patch: '' },
        { filename: 'README.md', patch: '' },
      ],
    })

    await run()

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('No lockfile changes detected'),
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('skips when all changed packages are ignored', async () => {
    setupDefaults()
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === 'ignore') return 'test-pkg'
      if (name === 'github-token') return 'fake-token'
      if (name === 'severity') return 'minor'
      if (name === 'fail-on') return 'major'
      return ''
    })

    await run()

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('All changed packages are ignored'),
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('creates comment and does NOT setFailed when deps are verified', async () => {
    const mockOctokit = setupDefaults()
    // diff returns verified result (actual === claimed)
    vi.mocked(diff).mockResolvedValue(
      makeChangeSet({
        actualSemver: 'minor',
        claimedSemver: 'minor',
      }),
    )

    await run()

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42,
      }),
    )
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith('Created new comment')
    expect(core.info).toHaveBeenCalledWith(
      'All dependency type changes match claimed semver.',
    )
    expect(core.setOutput).toHaveBeenCalledWith('result', 'pass')
    expect(core.setOutput).toHaveBeenCalledWith('actual-semver', 'minor')
  })

  it('creates comment and calls setFailed when deps are mismatched', async () => {
    const mockOctokit = setupDefaults()
    // diff returns mismatched result (actual > claimed, meets major threshold)
    vi.mocked(diff).mockResolvedValue(
      makeChangeSet({
        actualSemver: 'major',
        claimedSemver: 'minor',
      }),
    )

    await run()

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42,
      }),
    )
    expect(core.setFailed).toHaveBeenCalledWith(
      'Dependency type changes exceed claimed semver. See PR comment for details.',
    )
    expect(core.setOutput).toHaveBeenCalledWith('result', 'fail')
    expect(core.setOutput).toHaveBeenCalledWith('actual-semver', 'major')
  })

  it('updates existing comment when marker is found', async () => {
    const mockOctokit = setupDefaults()

    // Return an existing comment with the marker
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 999, body: 'Some other comment' },
        { id: 1001, body: '<!-- typediff-verify -->\n## Dependency Type Verification\n...' },
      ],
    })

    await run()

    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 1001,
      }),
    )
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith('Updated existing comment #1001')
  })

  it('calls setFailed when an Error is thrown outside diff()', async () => {
    const mockOctokit = setupDefaults()
    // Make listFiles throw to trigger the outer catch block
    mockOctokit.rest.pulls.listFiles.mockRejectedValue(
      new Error('Network timeout'),
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('Network timeout')
  })

  it('handles non-Error thrown values in catch block', async () => {
    const mockOctokit = setupDefaults()
    // Make listFiles throw a non-Error value
    mockOctokit.rest.pulls.listFiles.mockRejectedValue('string error')

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('An unexpected error occurred')
  })

  it('warns and continues when one diff in a batch fails', async () => {
    const mockOctokit = setupDefaults()

    // Two packages changed in lockfile
    mockOctokit.rest.pulls.listFiles.mockResolvedValue({
      data: [
        {
          filename: 'package-lock.json',
          patch: [
            'diff --git a/package-lock.json b/package-lock.json',
            '@@ -100,7 +100,7 @@',
            '     "node_modules/pkg-a": {',
            '-      "version": "1.0.0",',
            '+      "version": "1.1.0",',
            '       "resolved": "https://registry.npmjs.org/pkg-a/-/pkg-a-1.1.0.tgz",',
            '@@ -200,7 +200,7 @@',
            '     "node_modules/pkg-b": {',
            '-      "version": "2.0.0",',
            '+      "version": "2.1.0",',
            '       "resolved": "https://registry.npmjs.org/pkg-b/-/pkg-b-2.1.0.tgz",',
          ].join('\n'),
        },
      ],
    })

    // First call succeeds, second rejects
    vi.mocked(diff)
      .mockResolvedValueOnce(makeChangeSet({ packageName: 'pkg-a' }))
      .mockRejectedValueOnce(new Error('pkg-b failed'))

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('pkg-b failed'),
    )
    // Should still create comment with the successful result
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled()
  })

  it('skips comment when no analysis results are available', async () => {
    const mockOctokit = setupDefaults()

    // diff rejects for every package
    vi.mocked(diff).mockRejectedValue(new Error('all fail'))

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('No packages could be analyzed'),
    )
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled()
    // Outputs should still be set to safe defaults
    expect(core.setOutput).toHaveBeenCalledWith('result', 'pass')
    expect(core.setOutput).toHaveBeenCalledWith('actual-semver', 'patch')
  })

  it('passes severity option to diff()', async () => {
    setupDefaults()
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === 'severity') return 'patch'
      if (name === 'github-token') return 'fake-token'
      if (name === 'fail-on') return 'major'
      return ''
    })

    await run()

    expect(diff).toHaveBeenCalledWith(
      'test-pkg',
      '1.0.0',
      '1.1.0',
      { severity: 'patch' },
    )
  })

  it('skips when lockfile patch is empty (no version changes)', async () => {
    const mockOctokit = setupDefaults()
    mockOctokit.rest.pulls.listFiles.mockResolvedValue({
      data: [
        {
          filename: 'package-lock.json',
          patch: '',
        },
      ],
    })

    await run()

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('No dependency version changes detected'),
    )
  })
})

describe('chunk', () => {
  it('splits array into chunks of given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns single chunk when array is smaller than size', () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]])
  })

  it('returns empty array for empty input', () => {
    expect(chunk([], 3)).toEqual([])
  })

  it('returns one element per chunk when size is 1', () => {
    expect(chunk(['a', 'b', 'c'], 1)).toEqual([['a'], ['b'], ['c']])
  })

  it('handles exact multiples', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })
})
