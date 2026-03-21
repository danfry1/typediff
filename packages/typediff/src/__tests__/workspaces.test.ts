import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { resolveWorkspaces, runWorkspaces } from '../cli/commands/workspaces.js'

const FIXTURE_ROOT = resolve(import.meta.dirname, 'fixtures/workspace-root')

describe('resolveWorkspaces', () => {
  it('discovers non-private workspace packages', () => {
    const workspaces = resolveWorkspaces(FIXTURE_ROOT)
    const names = workspaces.map(w => w.name)
    expect(names).toContain('@test/core')
    expect(names).toContain('@test/utils')
  })

  it('filters out private packages', () => {
    const workspaces = resolveWorkspaces(FIXTURE_ROOT)
    const names = workspaces.map(w => w.name)
    expect(names).not.toContain('@test/private')
  })

  it('applies filter glob', () => {
    const workspaces = resolveWorkspaces(FIXTURE_ROOT, 'packages/core')
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].name).toBe('@test/core')
  })

  it('returns empty array for no matching filter', () => {
    const workspaces = resolveWorkspaces(FIXTURE_ROOT, 'packages/nonexistent')
    expect(workspaces).toHaveLength(0)
  })

  it('throws when no workspaces field in package.json', () => {
    // Use a fixture that has a package.json but no workspaces field
    const noWsRoot = resolve(import.meta.dirname, 'fixtures/export-added/new')
    expect(() => resolveWorkspaces(noWsRoot)).toThrow()
  })
})

describe('resolveWorkspaces with complex globs', () => {
  const COMPLEX_ROOT = resolve(import.meta.dirname, 'fixtures/workspace-complex')

  it('resolves complex workspace globs like libs/core-*', () => {
    const results = resolveWorkspaces(COMPLEX_ROOT)
    const names = results.map(w => w.name)
    expect(names).toContain('@test/core-utils')
    expect(names).toContain('@test/core-types')
    expect(names).not.toContain('@test/helper')
  })
})

describe('resolveWorkspaces with nested patterns', () => {
  const NESTED_ROOT = resolve(import.meta.dirname, 'fixtures/workspace-nested')

  it('discovers packages in nested directories with ** glob', () => {
    const results = resolveWorkspaces(NESTED_ROOT)
    const names = results.map(w => w.name)
    // packages/** should find all nested packages
    expect(names).toContain('@nested/pkg-one')
    expect(names).toContain('@nested/pkg-two')
    expect(names).toContain('@nested/pkg-three')
  })

  it('discovers packages in single-level glob (tools/*)', () => {
    const results = resolveWorkspaces(NESTED_ROOT)
    const names = results.map(w => w.name)
    expect(names).toContain('@nested/cli')
  })

  it('finds all workspace packages across both patterns', () => {
    const results = resolveWorkspaces(NESTED_ROOT)
    expect(results.length).toBe(4)
  })

  it('filters nested workspaces', () => {
    const results = resolveWorkspaces(NESTED_ROOT, 'packages/group-a/*')
    const names = results.map(w => w.name)
    expect(names).toContain('@nested/pkg-one')
    expect(names).toContain('@nested/pkg-two')
    expect(names).not.toContain('@nested/pkg-three')
    expect(names).not.toContain('@nested/cli')
  })
})

describe('runWorkspaces', () => {
  it('throws when all workspace comparisons fail', async () => {
    // Point at a real workspace root but use an unreachable registry so every
    // comparison fails with a network error (not "not found on npm").
    await expect(
      runWorkspaces(
        { registry: 'http://127.0.0.1:1' },
        undefined,
        FIXTURE_ROOT,
      ),
    ).rejects.toThrow(/failed/)
  })
})
