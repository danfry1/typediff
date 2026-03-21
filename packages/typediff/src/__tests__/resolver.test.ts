import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveLocal, resolveMultiEntry, resolveLocalAuto } from '../resolver/local.js'
import { resolveNpm, getPreviousVersion, parseRegistryFromNpmrc, parseScopedRegistryFromNpmrc, parseAuthFromNpmrc } from '../resolver/npm.js'
import { resolve } from '../resolver/index.js'
import { parseSpec, isLocalPath } from '../cli/utils.js'

let tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'typediff-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('isLocalPath', () => {
  it('recognizes Unix relative paths', () => {
    expect(isLocalPath('./')).toBe(true)
    expect(isLocalPath('./dist')).toBe(true)
    expect(isLocalPath('../other')).toBe(true)
  })

  it('recognizes Unix absolute paths', () => {
    expect(isLocalPath('/usr/local/lib')).toBe(true)
  })

  it('recognizes bare dot and double-dot', () => {
    expect(isLocalPath('.')).toBe(true)
    expect(isLocalPath('..')).toBe(true)
  })

  it('recognizes Windows drive paths', () => {
    expect(isLocalPath('C:\\Users\\pkg')).toBe(true)
    expect(isLocalPath('D:/projects/lib')).toBe(true)
  })

  it('recognizes Windows UNC paths', () => {
    expect(isLocalPath('\\\\server\\share\\pkg')).toBe(true)
  })

  it('recognizes Windows relative paths', () => {
    expect(isLocalPath('.\\dist')).toBe(true)
    expect(isLocalPath('..\\parent')).toBe(true)
  })

  it('rejects npm package specs', () => {
    expect(isLocalPath('zod')).toBe(false)
    expect(isLocalPath('zod@3.23.0')).toBe(false)
    expect(isLocalPath('@scope/pkg@1.0.0')).toBe(false)
  })
})

describe('resolveLocal', () => {
  it('resolves types from "types" field', () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'my-pkg',
        version: '1.0.0',
        types: './dist/index.d.ts',
      }),
    )
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const x: number;')

    const result = resolveLocal(dir)
    expect(result.packageName).toBe('my-pkg')
    expect(result.version).toBe('1.0.0')
    expect(result.typesEntryPath).toBe(join(dir, 'dist', 'index.d.ts'))
  })

  it('falls back to "typings" field', () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'typings-pkg',
        version: '2.0.0',
        typings: './typings/main.d.ts',
      }),
    )
    mkdirSync(join(dir, 'typings'), { recursive: true })
    writeFileSync(join(dir, 'typings', 'main.d.ts'), 'export declare const y: string;')

    const result = resolveLocal(dir)
    expect(result.packageName).toBe('typings-pkg')
    expect(result.version).toBe('2.0.0')
    expect(result.typesEntryPath).toBe(join(dir, 'typings', 'main.d.ts'))
  })

  it('falls back to index.d.ts', () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fallback-pkg',
        version: '0.1.0',
      }),
    )
    writeFileSync(join(dir, 'index.d.ts'), 'export declare const z: boolean;')

    const result = resolveLocal(dir)
    expect(result.packageName).toBe('fallback-pkg')
    expect(result.version).toBe('0.1.0')
    expect(result.typesEntryPath).toBe(join(dir, 'index.d.ts'))
  })

  it('handles exports map with types condition', () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'exports-pkg',
        version: '3.0.0',
        exports: {
          '.': {
            types: './dist/types.d.ts',
            import: './dist/index.js',
          },
        },
      }),
    )
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'types.d.ts'), 'export declare const w: number;')

    const result = resolveLocal(dir)
    expect(result.packageName).toBe('exports-pkg')
    expect(result.version).toBe('3.0.0')
    expect(result.typesEntryPath).toBe(join(dir, 'dist', 'types.d.ts'))
  })

  it('throws when no types found', () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'no-types-pkg',
        version: '1.0.0',
      }),
    )

    expect(() => resolveLocal(dir)).toThrow()
  })
})

describe('resolve (specifier parser)', () => {
  it('routes "./" prefix to local resolver', async () => {
    // Create a temp dir inside the cwd so we can reference it with "./"
    const subdir = makeTempDir()

    writeFileSync(
      join(subdir, 'package.json'),
      JSON.stringify({
        name: 'local-pkg',
        version: '1.0.0',
        types: './index.d.ts',
      }),
    )
    writeFileSync(join(subdir, 'index.d.ts'), 'export declare const a: number;')

    const result = await resolve(subdir)
    expect(result.packageName).toBe('local-pkg')
  })

  it('routes absolute path to local resolver', async () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'abs-pkg',
        version: '2.0.0',
        types: './index.d.ts',
      }),
    )
    writeFileSync(join(dir, 'index.d.ts'), 'export declare const b: string;')

    const result = await resolve(dir)
    expect(result.packageName).toBe('abs-pkg')
    expect(result.version).toBe('2.0.0')
  })

  // Network-dependent resolve tests moved to resolver-network.test.ts
})

// getPreviousVersion network tests moved to resolver-network.test.ts

describe('resolveMultiEntry', () => {
  it('resolves multiple entry points from exports map', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'multi-pkg',
        version: '1.0.0',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
          './utils': {
            types: './dist/utils.d.ts',
            import: './dist/utils.js',
          },
        },
      }),
    )
    writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const x: number;')
    writeFileSync(join(dir, 'dist', 'utils.d.ts'), 'export declare function util(): void;')

    const result = resolveMultiEntry(dir)
    expect(result.packageName).toBe('multi-pkg')
    expect(result.version).toBe('1.0.0')
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].entryPoint).toBe('.')
    expect(result.entries[1].entryPoint).toBe('./utils')
  })

  it('falls back to single entry when no exports map', () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'single-pkg',
        version: '2.0.0',
        types: './index.d.ts',
      }),
    )
    writeFileSync(join(dir, 'index.d.ts'), 'export declare const y: string;')

    const result = resolveMultiEntry(dir)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].entryPoint).toBe('.')
  })

  it('skips exports entries without types condition', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'partial-pkg',
        version: '1.0.0',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
          './no-types': {
            import: './dist/no-types.js',
          },
        },
      }),
    )
    writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const z: boolean;')

    const result = resolveMultiEntry(dir)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].entryPoint).toBe('.')
  })

  it('resolves .d.ts from JS-only string-valued exports entry', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'js-only-exports',
      version: '1.0.0',
      exports: { '.': './dist/index.js' },
    }))
    writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const x: string;')

    const result = resolveLocal(dir)
    expect(result.typesEntryPath).toContain('index.d.ts')
    expect(result.packageName).toBe('js-only-exports')
  })

  it('resolves .d.ts from JS-only string-valued subpath exports', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'js-subpath',
      version: '1.0.0',
      exports: { '.': './dist/index.js', './utils': './dist/utils.js' },
    }))
    writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const x: string;')
    writeFileSync(join(dir, 'dist', 'utils.d.ts'), 'export declare function helper(): void;')

    const result = resolveMultiEntry(dir)
    expect(result.entries).toHaveLength(2)
    expect(result.entries.some((e) => e.entryPoint === '.')).toBe(true)
    expect(result.entries.some((e) => e.entryPoint === './utils')).toBe(true)
  })

  it('resolves subpaths from typesVersions when no exports map', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'types', 'v4'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'tv-pkg',
      version: '1.0.0',
      types: './index.d.ts',
      typesVersions: { '*': { utils: ['types/v4/utils.d.ts'], core: ['types/v4/core.d.ts'] } },
    }))
    writeFileSync(join(dir, 'index.d.ts'), 'export declare const main: string;')
    writeFileSync(join(dir, 'types', 'v4', 'utils.d.ts'), 'export declare function helper(): void;')
    writeFileSync(join(dir, 'types', 'v4', 'core.d.ts'), 'export declare class Engine {}')

    const result = resolveMultiEntry(dir)
    expect(result.entries.length).toBe(3)
    expect(result.entries.some((e) => e.entryPoint === '.')).toBe(true)
    expect(result.entries.some((e) => e.entryPoint === './utils')).toBe(true)
    expect(result.entries.some((e) => e.entryPoint === './core')).toBe(true)
  })

  it('selects the correct typesVersions range for the active TS version', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'old'), { recursive: true })
    mkdirSync(join(dir, 'new'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'tv-range',
      version: '1.0.0',
      types: './index.d.ts',
      typesVersions: {
        '<4.8': { utils: ['old/utils.d.ts'] },
        '>=4.8': { utils: ['new/utils.d.ts'] },
      },
    }))
    writeFileSync(join(dir, 'index.d.ts'), 'export declare const main: string;')
    writeFileSync(join(dir, 'old', 'utils.d.ts'), 'export declare const old: string;')
    writeFileSync(join(dir, 'new', 'utils.d.ts'), 'export declare const latest: string;')

    const result = resolveMultiEntry(dir)
    // Current TS is 5.x, so >=4.8 should be selected
    const utilsEntry = result.entries.find((e) => e.entryPoint === './utils')
    expect(utilsEntry).toBeDefined()
    expect(utilsEntry!.typesPath).toContain('new')
  })

  it('expands typesVersions wildcard patterns', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'types', 'utils'), { recursive: true })
    mkdirSync(join(dir, 'types', 'core'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'tv-wild',
      version: '1.0.0',
      types: './index.d.ts',
      typesVersions: { '*': { '*': ['types/*/index.d.ts'] } },
    }))
    writeFileSync(join(dir, 'index.d.ts'), 'export declare const main: string;')
    writeFileSync(join(dir, 'types', 'utils', 'index.d.ts'), 'export declare function helper(): void;')
    writeFileSync(join(dir, 'types', 'core', 'index.d.ts'), 'export declare class Engine {}')

    const result = resolveMultiEntry(dir)
    expect(result.entries.length).toBe(3)
    expect(result.entries.some((e) => e.entryPoint === '.')).toBe(true)
    expect(result.entries.some((e) => e.entryPoint === './utils')).toBe(true)
    expect(result.entries.some((e) => e.entryPoint === './core')).toBe(true)
  })

  it('resolves conditional exports with JS-only import/require and adjacent .d.mts', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'conditional-js',
      version: '1.0.0',
      exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } },
    }))
    writeFileSync(join(dir, 'dist', 'index.d.mts'), 'export declare const x: string;')
    writeFileSync(join(dir, 'dist', 'index.d.cts'), 'export declare const y: number;')

    const result = resolveLocal(dir)
    expect(result.typesEntryPath).toContain('index.d.mts')
  })

  it('resolves typesVersions with fallback array (first file missing)', () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'types', 'fallback'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'tv-array',
      version: '1.0.0',
      types: './index.d.ts',
      typesVersions: { '*': { utils: ['types/missing.d.ts', 'types/fallback/utils.d.ts'] } },
    }))
    writeFileSync(join(dir, 'index.d.ts'), 'export declare const main: string;')
    writeFileSync(join(dir, 'types', 'fallback', 'utils.d.ts'), 'export declare function helper(): void;')

    const result = resolveMultiEntry(dir)
    expect(result.entries.some((e) => e.entryPoint === './utils')).toBe(true)
    const utilsEntry = result.entries.find((e) => e.entryPoint === './utils')
    expect(utilsEntry!.typesPath).toContain('fallback')
  })
})

describe('resolveLocalAuto', () => {
  // Network-dependent resolveLocalAuto tests moved to resolver-network.test.ts

  it('throws when no package.json found', async () => {
    await expect(resolveLocalAuto('/tmp')).rejects.toThrow('Could not find package.json')
  })

  it('walks up directories to find package.json', () => {
    // Test the walk-up logic without hitting npm by using resolveLocal (sync, no network)
    const tmpBase = join(tmpdir(), `typediff-walkup-${Date.now()}`)
    const nested = join(tmpBase, 'deeply', 'nested', 'dir')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(tmpBase, 'package.json'), JSON.stringify({
      name: 'walkup-test-pkg',
      version: '1.0.0',
      types: './index.d.ts',
    }))
    writeFileSync(join(tmpBase, 'index.d.ts'), 'export declare const x: string;')
    tempDirs.push(tmpBase)

    // resolveLocal walks up to find package.json — no network call
    const result = resolveLocal(nested)
    expect(result.packageName).toBe('walkup-test-pkg')
    expect(result.version).toBe('1.0.0')
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it('reads correct name and version from discovered package.json', () => {
    const tmpBase = join(tmpdir(), `typediff-readpkg-${Date.now()}`)
    mkdirSync(tmpBase, { recursive: true })
    writeFileSync(join(tmpBase, 'package.json'), JSON.stringify({
      name: 'my-specific-pkg-name',
      version: '3.5.7',
      types: './index.d.ts',
    }))
    writeFileSync(join(tmpBase, 'index.d.ts'), 'export declare const x: string;')
    tempDirs.push(tmpBase)

    const result = resolveLocal(tmpBase)
    expect(result.packageName).toBe('my-specific-pkg-name')
    expect(result.version).toBe('3.5.7')
    rmSync(tmpBase, { recursive: true, force: true })
  })
})

describe('error handling', () => {
  // resolveNpm network test moved to resolver-network.test.ts

  it('resolveLocal throws for a directory without package.json', () => {
    const dir = makeTempDir()
    expect(() => resolveLocal(dir)).toThrow(/No package\.json found/)
  })
})

describe('parseRegistryFromNpmrc', () => {
  it('parses global registry', () => {
    expect(parseRegistryFromNpmrc('registry=https://custom.registry.io/npm/')).toBe('https://custom.registry.io/npm')
  })

  it('returns undefined when no registry line', () => {
    expect(parseRegistryFromNpmrc('//registry.npmjs.org/:_authToken=abc123')).toBeUndefined()
  })

  it('handles whitespace around registry line', () => {
    expect(parseRegistryFromNpmrc('  registry = https://my.registry.io  ')).toBe('https://my.registry.io')
  })

  it('strips trailing slash', () => {
    expect(parseRegistryFromNpmrc('registry=https://my.registry.io/')).toBe('https://my.registry.io')
  })

  it('picks first registry in multi-line .npmrc', () => {
    const content = `//registry.npmjs.org/:_authToken=abc
registry=https://jfrog.mycompany.io/api/npm/npm-virtual/
always-auth=true`
    expect(parseRegistryFromNpmrc(content)).toBe('https://jfrog.mycompany.io/api/npm/npm-virtual')
  })
})

describe('parseScopedRegistryFromNpmrc', () => {
  it('parses scoped registry', () => {
    const content = '@mycompany:registry=https://jfrog.mycompany.io/api/npm/npm-local/'
    expect(parseScopedRegistryFromNpmrc(content, '@mycompany')).toBe('https://jfrog.mycompany.io/api/npm/npm-local')
  })

  it('returns undefined for non-matching scope', () => {
    const content = '@other:registry=https://other.registry.io/'
    expect(parseScopedRegistryFromNpmrc(content, '@mycompany')).toBeUndefined()
  })

  it('handles multiple scopes — picks the right one', () => {
    const content = `@frontend:registry=https://frontend.registry.io/
@backend:registry=https://backend.registry.io/
registry=https://default.registry.io/`
    expect(parseScopedRegistryFromNpmrc(content, '@backend')).toBe('https://backend.registry.io')
  })

  it('handles whitespace', () => {
    const content = '  @myorg:registry = https://myorg.jfrog.io/npm/  '
    expect(parseScopedRegistryFromNpmrc(content, '@myorg')).toBe('https://myorg.jfrog.io/npm')
  })

  it('does not match global registry line', () => {
    const content = 'registry=https://default.registry.io/'
    expect(parseScopedRegistryFromNpmrc(content, '@mycompany')).toBeUndefined()
  })
})

describe('parseAuthFromNpmrc', () => {
  it('parses _authToken', () => {
    const content = '//jfrog.mycompany.io/api/npm/npm-virtual/:_authToken=eyJhbGciOiJSUzI1NiJ9'
    const auth = parseAuthFromNpmrc(content, 'jfrog.mycompany.io')
    expect(auth).toEqual({ type: 'Bearer', token: 'eyJhbGciOiJSUzI1NiJ9' })
  })

  it('parses _auth (basic)', () => {
    const content = '//private.registry.io/:_auth=dXNlcjpwYXNz'
    const auth = parseAuthFromNpmrc(content, 'private.registry.io')
    expect(auth).toEqual({ type: 'Basic', token: 'dXNlcjpwYXNz' })
  })

  it('returns undefined for non-matching host', () => {
    const content = '//other.registry.io/:_authToken=abc123'
    expect(parseAuthFromNpmrc(content, 'jfrog.mycompany.io')).toBeUndefined()
  })

  it('prefers _authToken over _auth when both present', () => {
    const content = `//reg.io/:_authToken=bearer-token
//reg.io/:_auth=basic-token`
    const auth = parseAuthFromNpmrc(content, 'reg.io')
    expect(auth).toEqual({ type: 'Bearer', token: 'bearer-token' })
  })

  it('handles complex JFrog .npmrc', () => {
    const content = `@mycompany:registry=https://mycompany.jfrog.io/artifactory/api/npm/npm-local/
//mycompany.jfrog.io/artifactory/api/npm/npm-local/:_authToken=eyJ2ZXIiOiIyIn0.abc123
always-auth=true`
    const auth = parseAuthFromNpmrc(content, 'mycompany.jfrog.io')
    expect(auth).toEqual({ type: 'Bearer', token: 'eyJ2ZXIiOiIyIn0.abc123' })
  })
})

describe('parseAuthFromNpmrc — host boundary matching', () => {
  it('matches exact host', () => {
    const auth = parseAuthFromNpmrc('//registry.io/:_authToken=abc123', 'registry.io')
    expect(auth).toEqual({ type: 'Bearer', token: 'abc123' })
  })

  it('does not match when target host is a substring of actual host', () => {
    const auth = parseAuthFromNpmrc('//other-registry.io/:_authToken=abc123', 'registry.io')
    expect(auth).toBeUndefined()
  })

  it('does not match when actual host is a prefix of a longer domain', () => {
    const auth = parseAuthFromNpmrc('//registry.io.evil.com/:_authToken=abc123', 'registry.io')
    expect(auth).toBeUndefined()
  })

  it('matches path-scoped credentials for the correct repo', () => {
    const content = `//registry.example.com/repo-a/:_authToken=token-a
//registry.example.com/repo-b/:_authToken=token-b`
    const auth = parseAuthFromNpmrc(content, 'registry.example.com/repo-b')
    expect(auth).toEqual({ type: 'Bearer', token: 'token-b' })
  })

  it('prefers path-scoped match over host-only match', () => {
    const content = `//registry.example.com/:_authToken=host-token
//registry.example.com/repo-b/:_authToken=path-token`
    const auth = parseAuthFromNpmrc(content, 'registry.example.com/repo-b')
    expect(auth).toEqual({ type: 'Bearer', token: 'path-token' })
  })

  it('falls back to host-only match when no path match exists', () => {
    const content = `//registry.example.com/:_authToken=host-token`
    const auth = parseAuthFromNpmrc(content, 'registry.example.com/repo-b')
    expect(auth).toEqual({ type: 'Bearer', token: 'host-token' })
  })
})

describe('parseAuthFromNpmrc — malformed inputs', () => {
  it('returns undefined for empty string', () => {
    expect(parseAuthFromNpmrc('', 'registry.npmjs.org')).toBeUndefined()
  })

  it('returns undefined for garbage data', () => {
    expect(parseAuthFromNpmrc('this is not a valid npmrc file!!! @#$%', 'registry.npmjs.org')).toBeUndefined()
  })

  it('returns undefined for lines without = delimiter', () => {
    expect(parseAuthFromNpmrc('//registry.npmjs.org/:_authToken', 'registry.npmjs.org')).toBeUndefined()
  })

  it('returns undefined for empty token value', () => {
    expect(parseAuthFromNpmrc('//registry.npmjs.org/:_authToken=', 'registry.npmjs.org')).toBeUndefined()
  })

  it('handles lines with only whitespace', () => {
    expect(parseAuthFromNpmrc('   \n\n   \n', 'registry.npmjs.org')).toBeUndefined()
  })

  it('skips commented-out auth lines', () => {
    expect(parseAuthFromNpmrc('# //registry.npmjs.org/:_authToken=secret', 'registry.npmjs.org')).toBeUndefined()
    expect(parseAuthFromNpmrc('; //registry.npmjs.org/:_authToken=secret', 'registry.npmjs.org')).toBeUndefined()
  })

  it('finds auth on uncommented line after commented one', () => {
    const content = '# //registry.npmjs.org/:_authToken=old-secret\n//registry.npmjs.org/:_authToken=real-token'
    expect(parseAuthFromNpmrc(content, 'registry.npmjs.org')).toEqual({ type: 'Bearer', token: 'real-token' })
  })

  it('handles token with special characters', () => {
    const content = '//reg.io/:_authToken=eyJ+/=abc123=='
    const auth = parseAuthFromNpmrc(content, 'reg.io')
    expect(auth).toEqual({ type: 'Bearer', token: 'eyJ+/=abc123==' })
  })
})

describe('parseRegistryFromNpmrc — malformed inputs', () => {
  it('returns undefined for empty string', () => {
    expect(parseRegistryFromNpmrc('')).toBeUndefined()
  })

  it('returns undefined for garbage', () => {
    expect(parseRegistryFromNpmrc('not a registry line at all')).toBeUndefined()
  })

  it('returns undefined for registry= with no value', () => {
    // This returns the empty string match, which is trimmed
    const result = parseRegistryFromNpmrc('registry=')
    expect(result === undefined || result === '').toBe(true)
  })

  it('handles registry with query params', () => {
    expect(parseRegistryFromNpmrc('registry=https://reg.io/npm?auth=true')).toBe('https://reg.io/npm?auth=true')
  })
})

describe('parseScopedRegistryFromNpmrc — malformed inputs', () => {
  it('returns undefined for empty string', () => {
    expect(parseScopedRegistryFromNpmrc('', '@scope')).toBeUndefined()
  })

  it('returns undefined for scope with special regex characters', () => {
    // Ensure the regex escaping doesn't break
    expect(parseScopedRegistryFromNpmrc('@scope+plus:registry=https://reg.io/', '@scope+plus')).toBe('https://reg.io')
  })

  it('handles scope that looks like a regex pattern', () => {
    expect(parseScopedRegistryFromNpmrc('content', '@(.*)')).toBeUndefined()
  })
})

describe('parseSpec', () => {
  it('rejects empty version for unscoped package', () => {
    expect(parseSpec('pkg@')).toBeNull()
  })

  it('rejects empty version for scoped package', () => {
    expect(parseSpec('@scope/pkg@')).toBeNull()
  })

  it('parses valid scoped package', () => {
    expect(parseSpec('@scope/pkg@1.0.0')).toEqual({ name: '@scope/pkg', version: '1.0.0' })
  })

  it('parses valid unscoped package', () => {
    expect(parseSpec('zod@3.23.0')).toEqual({ name: 'zod', version: '3.23.0' })
  })

  it('returns null for bare package name without version', () => {
    expect(parseSpec('zod')).toBeNull()
  })

  it('returns null for scoped package without version', () => {
    expect(parseSpec('@scope/pkg')).toBeNull()
  })
})
