import { describe, it, expect } from 'vitest'
import type { ChangeSet } from '../core/types.js'
import { formatJson } from '../cli/formatters/json.js'
import { formatPretty } from '../cli/formatters/pretty.js'

/** Strip ANSI escape codes so assertions can check plain text content. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

const sampleResult: ChangeSet = {
  packageName: 'some-lib',
  oldVersion: '4.1.0',
  newVersion: '4.2.0',
  changes: [
    {
      kind: 'changed',
      path: 'SomeConfig.mode',
      semver: 'major',
      description: "type narrowed from 'string' to '\"fast\" | \"slow\"'",
      oldSignature: 'string',
      newSignature: '"fast" | "slow"',
    },
    {
      kind: 'added',
      path: 'createClient',
      semver: 'minor',
      description: "function 'createClient' was added",
      newSignature: '() => Client',
    },
  ],
  actualSemver: 'major',
  claimedSemver: 'minor',
}

describe('JSON formatter', () => {
  it('produces valid JSON with schemaVersion: 1', () => {
    const output = formatJson([sampleResult])
    const parsed = JSON.parse(output)
    expect(parsed.schemaVersion).toBe(1)
  })

  it('contains results array with data', () => {
    const output = formatJson([sampleResult])
    const parsed = JSON.parse(output)
    expect(parsed.results).toBeInstanceOf(Array)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].packageName).toBe('some-lib')
    expect(parsed.results[0].changes).toHaveLength(2)
  })
})

describe('Pretty formatter', () => {
  it('shows package name and versions', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toContain('some-lib')
    expect(output).toContain('4.1.0')
    expect(output).toContain('4.2.0')
  })

  it('shows "BREAKING" for major changes', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toMatch(/BREAKING/i)
  })

  it('shows individual change paths', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toContain('SomeConfig.mode')
    expect(output).toContain('createClient')
  })

  it('handles empty changes ("No type changes detected")', () => {
    const emptyResult: ChangeSet = {
      packageName: 'empty-lib',
      oldVersion: '1.0.0',
      newVersion: '1.0.1',
      changes: [],
      actualSemver: 'patch',
      claimedSemver: 'patch',
    }
    const output = strip(formatPretty([emptyResult]))
    expect(output).toContain('No type changes detected')
  })

  it('shows MISMATCH when claimed vs actual do not match', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toContain('MISMATCH')
  })

  it('shows VERIFIED when claimed matches actual', () => {
    const matchResult: ChangeSet = {
      packageName: 'good-lib',
      oldVersion: '1.0.0',
      newVersion: '1.1.0',
      changes: [
        {
          kind: 'added',
          path: 'newFunc',
          semver: 'minor',
          description: 'Added newFunc',
        },
      ],
      actualSemver: 'minor',
      claimedSemver: 'minor',
    }
    const output = strip(formatPretty([matchResult]))
    expect(output).toContain('VERIFIED')
  })

  it('shows summary bar with counts', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toContain('1 breaking')
    expect(output).toContain('1 minor')
  })

  it('collapses compatible changes by default', () => {
    const manyPatch: ChangeSet = {
      packageName: 'big-lib',
      oldVersion: '1.0.0',
      newVersion: '1.0.1',
      changes: Array.from({ length: 10 }, (_, i) => ({
        kind: 'changed' as const,
        path: `thing${i}`,
        semver: 'patch' as const,
        description: `changed thing ${i}`,
      })),
      actualSemver: 'patch',
      claimedSemver: 'patch',
    }
    const output = strip(formatPretty([manyPatch]))
    expect(output).toContain('10 changes verified as non-breaking')
    // Individual patch changes should NOT appear
    expect(output).not.toContain('thing0')
  })

  it('shows compatible changes in verbose mode', () => {
    const manyPatch: ChangeSet = {
      packageName: 'big-lib',
      oldVersion: '1.0.0',
      newVersion: '1.0.1',
      changes: Array.from({ length: 10 }, (_, i) => ({
        kind: 'changed' as const,
        path: `thing${i}`,
        semver: 'patch' as const,
        description: `changed thing ${i}`,
      })),
      actualSemver: 'patch',
      claimedSemver: 'patch',
    }
    const output = strip(formatPretty([manyPatch], { verbose: true }))
    expect(output).toContain('thing0')
    expect(output).toContain('thing9')
  })

  it('collapses minor changes beyond 5 when not verbose', () => {
    const manyMinor: ChangeSet = {
      packageName: 'growing-lib',
      oldVersion: '1.0.0',
      newVersion: '1.1.0',
      changes: Array.from({ length: 12 }, (_, i) => ({
        kind: 'added' as const,
        path: `newFunc${i}`,
        semver: 'minor' as const,
        description: `Added newFunc${i}`,
      })),
      actualSemver: 'minor',
      claimedSemver: 'minor',
    }
    const output = strip(formatPretty([manyMinor]))
    expect(output).toContain('newFunc0')
    expect(output).toContain('newFunc4')
    expect(output).not.toContain('newFunc5')
    expect(output).toContain('... and 7 more minor changes')
  })

  it('shows typediff branding in header', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toContain('typediff')
  })

  it('shows arrow between versions', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toContain('4.1.0 \u2192 4.2.0')
  })

  it('shows signature changes for breaking items', () => {
    const output = strip(formatPretty([sampleResult]))
    expect(output).toContain('string')
    expect(output).toContain('"fast" | "slow"')
  })
})

describe('quiet mode', () => {
  it('formats as single line in pretty mode', () => {
    const result: ChangeSet = {
      packageName: 'zod', oldVersion: '3.22.0', newVersion: '3.23.0',
      changes: [], actualSemver: 'major', claimedSemver: 'minor',
    }
    const output = formatPretty([result], { quiet: true })
    expect(output.split('\n').length).toBe(1)
    expect(strip(output)).toContain('zod')
    expect(strip(output)).toContain('MISMATCH')
  })

  it('shows VERIFIED for matching semver', () => {
    const result: ChangeSet = {
      packageName: 'axios', oldVersion: '1.7.2', newVersion: '1.7.3',
      changes: [], actualSemver: 'patch', claimedSemver: 'patch',
    }
    const output = formatPretty([result], { quiet: true })
    expect(strip(output)).toContain('VERIFIED')
  })

  it('JSON quiet omits changes array', () => {
    const result: ChangeSet = {
      packageName: 'zod', oldVersion: '3.22.0', newVersion: '3.23.0',
      changes: [{ kind: 'removed' as const, path: 'foo', semver: 'major' as const, description: 'removed' }],
      actualSemver: 'major', claimedSemver: 'minor',
    }
    const output = formatJson([result], { quiet: true })
    const parsed = JSON.parse(output)
    expect(parsed.results[0].changes).toBeUndefined()
    expect(parsed.results[0].verified).toBe(false)
  })

  it('does not append elapsed time footer in quiet mode', () => {
    const result: ChangeSet = {
      packageName: 'test-lib', oldVersion: '1.0.0', newVersion: '1.1.0',
      changes: [], actualSemver: 'minor', claimedSemver: 'minor',
    }
    const output = strip(formatPretty([result], { quiet: true, elapsedMs: 1234 }))
    expect(output).not.toContain('Done in')
  })
})

describe('verbose timings', () => {
  it('displays timings in verbose mode when present', () => {
    const result: ChangeSet = {
      packageName: 'test', oldVersion: '1.0.0', newVersion: '1.1.0',
      changes: [], actualSemver: 'patch', claimedSemver: 'minor',
      timings: { extractMs: 150, diffMs: 30, totalMs: 200 },
    }
    const output = strip(formatPretty([result], { verbose: true }))
    expect(output).toContain('extract 150ms')
    expect(output).toContain('total 200ms')
  })

  it('does not display timings in non-verbose mode', () => {
    const result: ChangeSet = {
      packageName: 'test', oldVersion: '1.0.0', newVersion: '1.1.0',
      changes: [], actualSemver: 'patch', claimedSemver: 'minor',
      timings: { extractMs: 150, diffMs: 30, totalMs: 200 },
    }
    const output = strip(formatPretty([result]))
    expect(output).not.toContain('extract 150ms')
  })

  it('includes resolve timing when present', () => {
    const result: ChangeSet = {
      packageName: 'test', oldVersion: '1.0.0', newVersion: '1.1.0',
      changes: [], actualSemver: 'patch', claimedSemver: 'minor',
      timings: { resolveMs: 500, extractMs: 150, diffMs: 30, totalMs: 700 },
    }
    const output = strip(formatPretty([result], { verbose: true }))
    expect(output).toContain('resolve 500ms')
  })
})
