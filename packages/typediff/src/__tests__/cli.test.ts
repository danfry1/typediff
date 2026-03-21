import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const CLI = resolve(import.meta.dirname, '../cli/index.ts')

function run(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execFileSync('bun', ['run', CLI, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    })
    // execFileSync returns stdout; stderr is not captured on success.
    // Use spawnSync for stderr capture in tests that need it.
    return { stdout: result, stderr: '', exitCode: 0 }
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1,
    }
  }
}

/** Like run() but captures stderr even on success (uses spawnSync). */
function runWithStderr(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bun', ['run', CLI, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

describe('CLI integration', () => {
  it('exits 2 on unknown command', () => {
    const { exitCode, stderr } = run(['unknown'])
    expect(exitCode).toBe(2)
    expect(stderr).toContain('Unknown command')
  })

  it('exits 2 with no arguments', () => {
    const { exitCode } = run([])
    expect(exitCode).toBe(2)
  })

  it('outputs valid JSON with --format json for local fixtures', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/no-changes/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/no-changes/new')
    const { stdout, exitCode } = run(['inspect', fixtureOld, fixtureNew, '--format', 'json'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.results).toHaveLength(1)
  })

  it('--quiet produces single line', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/no-changes/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/no-changes/new')
    const { stdout, exitCode } = run(['inspect', fixtureOld, fixtureNew, '--quiet', '--format', 'pretty'])
    expect(exitCode).toBe(0)
    const lines = stdout.trim().split('\n')
    expect(lines.length).toBe(1)
  })

  it('--exit-code returns 1 for breaking changes', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/export-removed/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/export-removed/new')
    const { exitCode } = run(['inspect', fixtureOld, fixtureNew, '--exit-code'])
    expect(exitCode).toBe(1)
  })

  it('--exit-code returns 0 for minor-only changes without --severity', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/export-added/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/export-added/new')
    const { exitCode } = run(['inspect', fixtureOld, fixtureNew, '--exit-code'])
    // export-added is a minor change — without --severity, exit-code only triggers on major
    expect(exitCode).toBe(0)
  })

  it('--exit-code with --severity minor returns 1 for minor changes', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/export-added/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/export-added/new')
    const { exitCode } = run(['inspect', fixtureOld, fixtureNew, '--exit-code', '--severity', 'minor'])
    expect(exitCode).toBe(1)
  })

  it('snapshot command exits 2 for nonexistent path', () => {
    const { exitCode, stderr } = run(['snapshot', '/nonexistent/path/does/not/exist'])
    expect(exitCode).toBe(2)
    expect(stderr).toContain('Path not found')
  })

  it('snapshot command produces valid JSON', () => {
    const fixture = resolve(import.meta.dirname, 'fixtures/export-added/new')
    const { stdout, exitCode } = run(['snapshot', fixture])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.snapshotVersion).toBe(1)
    expect(parsed.entryPoints).toBeDefined()
  })

  it('--exit-code --severity patch returns 0 when no changes exist', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/no-changes/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/no-changes/new')
    const { exitCode } = run(['inspect', fixtureOld, fixtureNew, '--exit-code', '--severity', 'patch'])
    // No changes at all — should exit 0, not 1
    expect(exitCode).toBe(0)
  })

  it('shows help with --help', () => {
    const { stdout, exitCode } = run(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('typediff')
  })

  it('shows version with --version', () => {
    const { stdout, exitCode } = run(['--version'])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('--ignore filters out matching exports', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/export-removed/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/export-removed/new')
    const { stdout, exitCode } = run(['inspect', fixtureOld, fixtureNew, '--format', 'json', '--ignore', 'b'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    // 'b' was removed but ignored — should have no changes
    const changes = parsed.results[0].changes
    expect(changes.filter((c: any) => c.path === 'b')).toHaveLength(0)
  })

  it('--respect-tags downgrades @internal removals', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/tsdoc-tags/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/tsdoc-tags/new')
    const { stdout, exitCode } = run(['inspect', fixtureOld, fixtureNew, '--format', 'json', '--respect-tags'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    const changes = parsed.results[0].changes
    // @internal removal should be downgraded from major to patch
    const internalChange = changes.find((c: any) => c.path === 'internalApi')
    expect(internalChange).toBeDefined()
    expect(internalChange.semver).toBe('patch')
    // @beta removal should be downgraded from major to minor
    const betaChange = changes.find((c: any) => c.path === 'betaApi')
    expect(betaChange).toBeDefined()
    expect(betaChange.semver).toBe('minor')
  })

  it('--debug outputs diagnostic info to stderr', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/no-changes/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/no-changes/new')
    const { stderr, exitCode } = runWithStderr(['inspect', fixtureOld, fixtureNew, '--debug'])
    expect(exitCode).toBe(0)
    expect(stderr).toContain('[debug]')
  })

  it('--json shorthand outputs valid JSON', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/no-changes/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/no-changes/new')
    const { stdout, exitCode } = run(['inspect', fixtureOld, fixtureNew, '--json'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.schemaVersion).toBe(1)
  })

  it('warns on extra positional arguments', () => {
    const fixtureOld = resolve(import.meta.dirname, 'fixtures/no-changes/old')
    const fixtureNew = resolve(import.meta.dirname, 'fixtures/no-changes/new')
    const { stderr, exitCode } = runWithStderr(['inspect', fixtureOld, fixtureNew, fixtureOld, '--json'])
    expect(exitCode).toBe(0)
    expect(stderr).toContain('ignoring extra arguments')
  })

  it('--workspaces works without inspect command', () => {
    const wsRoot = resolve(import.meta.dirname, 'fixtures/workspace-root')
    // Should not exit 2 with "No command specified"
    const { exitCode, stderr } = runWithStderr(['--workspaces', '--format', 'json'], wsRoot)
    expect(exitCode).toBe(0)
  })

  it('exits 2 for invalid --severity value', () => {
    const { exitCode, stderr } = run(['inspect', 'foo@1.0.0', '--severity', 'invalid'])
    expect(exitCode).toBe(2)
    expect(stderr).toContain('Invalid severity')
  })

  it('exits 2 for inspect with no arguments', () => {
    const { exitCode, stderr } = run(['inspect'])
    expect(exitCode).toBe(2)
    expect(stderr).toContain('inspect requires')
  })

  it('compare command exits 2 with insufficient arguments', () => {
    const { exitCode, stderr } = run(['compare', 'only-one-arg'])
    expect(exitCode).toBe(2)
    expect(stderr).toContain('compare requires two arguments')
  })

  it('--include-internals shows underscore-prefixed members', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'typediff-cli-test-'))
    const newDir = mkdtempSync(join(tmpdir(), 'typediff-cli-test-'))
    writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', types: './index.d.ts' }))
    writeFileSync(join(oldDir, 'index.d.ts'), 'export declare const _internal: number;\nexport declare const pub: string;')
    writeFileSync(join(newDir, 'package.json'), JSON.stringify({ name: 'test', version: '2.0.0', types: './index.d.ts' }))
    writeFileSync(join(newDir, 'index.d.ts'), 'export declare const pub: string;')
    try {
      // Without --include-internals, _internal removal is filtered out
      const { stdout: without } = run(['inspect', oldDir, newDir, '--format', 'json'])
      const parsedWithout = JSON.parse(without)
      const changesWithout = parsedWithout.results[0].changes
      expect(changesWithout.filter((c: any) => c.path === '_internal')).toHaveLength(0)

      // With --include-internals, _internal removal appears
      const { stdout: withIt } = run(['inspect', oldDir, newDir, '--format', 'json', '--include-internals'])
      const parsedWith = JSON.parse(withIt)
      const changesWith = parsedWith.results[0].changes
      expect(changesWith.filter((c: any) => c.path === '_internal')).toHaveLength(1)
    } finally {
      rmSync(oldDir, { recursive: true, force: true })
      rmSync(newDir, { recursive: true, force: true })
    }
  })
})

describe('CLI --workspaces', () => {
  it('scans workspace packages via CLI subprocess', () => {
    const wsRoot = resolve(import.meta.dirname, 'fixtures/workspace-root')
    // The fixture packages (@test/core, @test/utils) aren't published to npm,
    // so runWorkspaces will skip them as "unpublished". The important thing is
    // the CLI runs without crashing and exits cleanly.
    const { exitCode, stderr } = runWithStderr(['inspect', '--workspaces', '--format', 'json'], wsRoot)
    expect(exitCode).toBe(0)
    // Verify that it found and attempted workspaces (skipped as unpublished)
    expect(stderr).toContain('Skipped')
  })

  it('--workspaces exits 0 with empty results for no publishable workspaces', () => {
    // Create a temp workspace with only private packages
    const dir = mkdtempSync(join(tmpdir(), 'typediff-ws-test-'))
    const pkgDir = join(dir, 'packages', 'private-only')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-mono', private: true, workspaces: ['packages/*'] }))
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'private-pkg', private: true, version: '1.0.0' }))
    writeFileSync(join(pkgDir, 'index.d.ts'), 'export declare const x: number;')

    try {
      const { exitCode, stderr } = runWithStderr(['inspect', '--workspaces', '--format', 'json'], dir)
      expect(exitCode).toBe(0)
      expect(stderr).toContain('No publishable workspaces')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CLI .typediffrc.json config', () => {
  let tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  function createFixtureWithRc(rc: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'typediff-rc-test-'))
    tempDirs.push(dir)

    // Create old/new package dirs inside
    const oldDir = join(dir, 'old')
    const newDir = join(dir, 'new')
    for (const d of [oldDir, newDir]) {
      mkdirSync(d, { recursive: true })
    }

    writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', types: './index.d.ts' }))
    writeFileSync(join(oldDir, 'index.d.ts'), 'export declare const a: string;\nexport declare const b: number;')
    writeFileSync(join(newDir, 'package.json'), JSON.stringify({ name: 'test', version: '2.0.0', types: './index.d.ts' }))
    writeFileSync(join(newDir, 'index.d.ts'), 'export declare const a: string;')

    // Write rc config
    writeFileSync(join(dir, '.typediffrc.json'), JSON.stringify(rc))

    return { dir, oldDir, newDir }
  }

  it('reads ignore from .typediffrc.json', () => {
    const { dir, oldDir, newDir } = createFixtureWithRc({ ignore: ['b'] })

    const { stdout, exitCode } = run(['inspect', oldDir, newDir, '--format', 'json'], dir)
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    const changes = parsed.results[0].changes
    // 'b' removal should be filtered by rc config
    expect(changes.filter((c: any) => c.path === 'b')).toHaveLength(0)
  })

  it('CLI flags override .typediffrc.json', () => {
    // RC says ignore 'b', but CLI explicitly does NOT ignore anything
    const { dir, oldDir, newDir } = createFixtureWithRc({ ignore: ['b'] })

    // Passing --ignore with a non-matching pattern should override the rc
    const { stdout, exitCode } = run(['inspect', oldDir, newDir, '--format', 'json', '--ignore', 'nonexistent'], dir)
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    const changes = parsed.results[0].changes
    // 'b' removal should NOT be filtered since CLI override replaced rc ignore
    expect(changes.filter((c: any) => c.path === 'b')).toHaveLength(1)
  })

  it('handles malformed .typediffrc.json gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typediff-rc-test-'))
    tempDirs.push(dir)

    const oldDir = join(dir, 'old')
    const newDir = join(dir, 'new')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(newDir, { recursive: true })

    writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', types: './index.d.ts' }))
    writeFileSync(join(oldDir, 'index.d.ts'), 'export declare const a: string;')
    writeFileSync(join(newDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.1', types: './index.d.ts' }))
    writeFileSync(join(newDir, 'index.d.ts'), 'export declare const a: string;')

    // Write invalid JSON
    writeFileSync(join(dir, '.typediffrc.json'), '{not valid json!!!}')

    const { exitCode, stderr } = runWithStderr(['inspect', oldDir, newDir, '--format', 'json'], dir)
    // Should still run (rc parse failure is non-fatal), just warn
    expect(exitCode).toBe(0)
    expect(stderr).toContain('Warning')
  })

  it('reads exitCode from .typediffrc.json', () => {
    const { dir, oldDir, newDir } = createFixtureWithRc({ exitCode: true })

    // b is removed → major → should exit 1 because exitCode=true in rc
    const { exitCode } = run(['inspect', oldDir, newDir], dir)
    expect(exitCode).toBe(1)
  })
})
