import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveLocalAuto } from '../resolver/local.js'
import { resolveNpm, getPreviousVersion } from '../resolver/npm.js'
import { resolve } from '../resolver/index.js'

/**
 * These tests require network access to the npm registry.
 * They are excluded from the default `bun run test` command
 * and run separately in CI via `test:all`.
 */

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('getPreviousVersion (network)', () => {
  it('finds the previous version of a package', async () => {
    const prev = await getPreviousVersion('zod', '3.23.0')
    expect(prev).toMatch(/^3\.22/)
  }, 15_000)

  it('returns null for the first version', async () => {
    const prev = await getPreviousVersion('zod', '0.0.0')
    expect(prev).toBeNull()
  }, 15_000)

  it('returns null for a non-existent version', async () => {
    const prev = await getPreviousVersion('zod', '999.999.999')
    expect(prev).toBeNull()
  }, 15_000)
})

describe('resolveLocalAuto (network)', () => {
  it('finds package.json walking up from types directory', async () => {
    const fixturePath = resolvePath(__dirname, 'fixtures/export-added/new')
    const result = await resolveLocalAuto(fixturePath)
    expect(result.packageName).toBe('test')
    expect(result.newVersion).toBe('1.1.0')
    expect(result.oldVersion).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('resolve specifier routing (network)', () => {
  it('parses pkg@version format and routes to npm', async () => {
    await expect(
      resolve('nonexistent-pkg-that-surely-does-not-exist@0.0.0-fake'),
    ).rejects.toThrow()
  })

  it('parses @scope/pkg@version format and routes to npm', async () => {
    await expect(
      resolve('@fake-scope/fake-pkg@0.0.0-fake'),
    ).rejects.toThrow()
  })
})

describe('resolveNpm error handling (network)', () => {
  it('throws a clear error for a non-existent package', async () => {
    await expect(
      resolveNpm('this-package-surely-does-not-exist-on-npm-12345', '0.0.0'),
    ).rejects.toThrow(/not found on npm.*Check the package name and version/)
  })
})
