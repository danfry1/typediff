import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import ts from 'typescript'
import semver from 'semver'
import { getPreviousVersion, getLatestVersion, type NpmResolveOptions } from './npm.js'

export interface ResolveResult {
  typesEntryPath: string
  packageName: string
  version: string
  packageDir: string
}

/**
 * Walk up from `startDir` to find the nearest directory containing a package.json.
 * Returns the directory path, or null if none found.
 */
function findPackageRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function resolveLocal(dir: string): ResolveResult {
  const absDir = resolve(dir)
  let pkgDir = absDir
  if (!existsSync(join(absDir, 'package.json'))) {
    const found = findPackageRoot(absDir)
    if (!found) throw new Error(`No package.json found in or above ${absDir}`)
    pkgDir = found
  }
  const pkgJsonPath = join(pkgDir, 'package.json')

  const raw = readFileSync(pkgJsonPath, 'utf-8')
  const pkg = JSON.parse(raw) as Record<string, unknown>

  const packageName = (pkg.name as string) ?? 'unknown'
  const version = (pkg.version as string) ?? '0.0.0'

  // 1. Check exports["."].types (resolved relative to package.json location)
  const typesFromExports = getExportsTypes(pkg)
  if (typesFromExports) {
    const resolved = resolve(pkgDir, typesFromExports)
    if (existsSync(resolved)) {
      return { typesEntryPath: resolved, packageName, version, packageDir: pkgDir }
    }
  }

  // 2. Check "types" field
  if (typeof pkg.types === 'string') {
    const resolved = resolve(pkgDir, pkg.types)
    if (existsSync(resolved)) {
      return { typesEntryPath: resolved, packageName, version, packageDir: pkgDir }
    }
  }

  // 3. Check "typings" field
  if (typeof pkg.typings === 'string') {
    const resolved = resolve(pkgDir, pkg.typings)
    if (existsSync(resolved)) {
      return { typesEntryPath: resolved, packageName, version, packageDir: pkgDir }
    }
  }

  // 4. Fallback to index.d.ts in the provided directory or package root
  for (const d of [absDir, pkgDir]) {
    const fallback = join(d, 'index.d.ts')
    if (existsSync(fallback)) {
      return { typesEntryPath: fallback, packageName, version, packageDir: pkgDir }
    }
  }

  throw new Error(
    `No type definitions found in ${absDir}. ` +
      `Checked: exports["."].types, types, typings, and index.d.ts`,
  )
}

export interface MultiEntryResult {
  entries: Array<{ entryPoint: string; typesPath: string }>
  packageName: string
  version: string
}

export function resolveMultiEntry(dir: string): MultiEntryResult {
  const absDir = resolve(dir)
  let pkgDir = absDir
  if (!existsSync(join(absDir, 'package.json'))) {
    const found = findPackageRoot(absDir)
    if (!found) throw new Error(`No package.json found in or above ${absDir}`)
    pkgDir = found
  }
  const pkgJsonPath = join(pkgDir, 'package.json')

  const raw = readFileSync(pkgJsonPath, 'utf-8')
  const pkg = JSON.parse(raw) as Record<string, unknown>

  const packageName = (pkg.name as string) ?? 'unknown'
  const version = (pkg.version as string) ?? '0.0.0'

  // If exports map exists, resolve each subpath with types condition
  if (pkg.exports && typeof pkg.exports === 'object') {
    const exportsMap = pkg.exports as Record<string, unknown>
    const keys = Object.keys(exportsMap)
    const hasSubpaths = keys.some((k) => k.startsWith('.'))

    // Flat condition map (no subpaths) — treat as single "." entry
    if (!hasSubpaths) {
      const typesPath = findTypesInCondition(exportsMap)
      if (typesPath) {
        const resolved = resolve(pkgDir, typesPath)
        if (existsSync(resolved)) {
          return { entries: [{ entryPoint: '.', typesPath: resolved }], packageName, version }
        }
      }
    }

    // Subpath exports map
    const entries: Array<{ entryPoint: string; typesPath: string }> = []
    for (const [key, value] of Object.entries(exportsMap)) {
      if (value == null) continue
      let typesPath = findTypesInCondition(value)

      // String-valued export (JS entry, no types condition) — try adjacent .d.ts
      if (!typesPath && typeof value === 'string') {
        typesPath = inferDtsFromJs(value)
      }

      if (typesPath) {
        const resolved = resolve(pkgDir, typesPath)
        if (existsSync(resolved)) {
          entries.push({ entryPoint: key, typesPath: resolved })
        }
      }
    }

    if (entries.length > 0) {
      return { entries, packageName, version }
    }
  }

  // Check typesVersions for subpath declarations (common in DefinitelyTyped and older packages)
  if (pkg.typesVersions && typeof pkg.typesVersions === 'object') {
    const versionMap = selectTypesVersions(pkg.typesVersions as Record<string, unknown>)
    if (versionMap) {
      const entries: Array<{ entryPoint: string; typesPath: string }> = []

      const rootResult = resolveLocal(dir)
      const seenEntryPoints = new Set<string>(['.'])
      entries.push({ entryPoint: '.', typesPath: rootResult.typesEntryPath })

      for (const [subpath, targets] of Object.entries(versionMap)) {
        if (!Array.isArray(targets) || targets.length === 0) continue

        // Try targets in order (TypeScript uses first-match fallback)
        let matched = false
        for (const target of targets) {
          if (typeof target !== 'string') continue

          if (subpath.includes('*')) {
            const expanded = expandTypesVersionsWildcard(pkgDir, subpath, target)
            if (expanded.length > 0) {
              for (const entry of expanded) {
                if (!seenEntryPoints.has(entry.entryPoint)) {
                  seenEntryPoints.add(entry.entryPoint)
                  entries.push(entry)
                }
              }
              matched = true
              break
            }
          } else {
            const entryPoint = `./${subpath}`
            const resolved = resolve(pkgDir, target)
            if (existsSync(resolved) && !seenEntryPoints.has(entryPoint)) {
              seenEntryPoints.add(entryPoint)
              entries.push({ entryPoint, typesPath: resolved })
              matched = true
              break
            }
          }
        }
        if (matched) continue
      }

      if (entries.length > 1) {
        return { entries, packageName, version }
      }
    }
  }

  // Fallback: single entry point
  const single = resolveLocal(dir)
  return {
    entries: [{ entryPoint: '.', typesPath: single.typesEntryPath }],
    packageName: single.packageName,
    version: single.version,
  }
}

export interface LocalAutoResult {
  packageName: string
  oldVersion: string
  newVersion: string
  localPath: string
}

export async function resolveLocalAuto(localPath: string, npmOptions?: NpmResolveOptions): Promise<LocalAutoResult> {
  const absPath = resolve(localPath)

  // Walk up to find package.json
  let dir = absPath
  let pkgJson: Record<string, unknown> | null = null
  while (true) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      pkgJson = JSON.parse(readFileSync(candidate, 'utf-8'))
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break  // filesystem root
    dir = parent
  }

  if (!pkgJson || typeof pkgJson.name !== 'string') {
    throw new Error(
      'Could not find package.json. Use `typediff inspect ./dist my-lib@version` to specify explicitly.'
    )
  }

  const packageName = pkgJson.name
  const version = (pkgJson.version as string) ?? '0.0.0'

  // Determine old version from npm
  let oldVersion: string
  let networkError: Error | null = null
  const prev = await getPreviousVersion(packageName, version, npmOptions).catch((err) => {
    networkError = err instanceof Error ? err : new Error(String(err))
    return null
  })
  if (prev) {
    oldVersion = prev
  } else {
    // getPreviousVersion returns null if version not in registry
    // Try to check if the package exists at all by getting latest dist-tag
    try {
      const latest = await getLatestVersion(packageName, npmOptions).catch(() => null)
      if (latest) {
        // Package exists but our version isn't published yet — use latest as baseline
        oldVersion = latest
      } else if (networkError) {
        throw new Error(
          `Failed to reach npm registry for '${packageName}': ${(networkError as Error).message}`,
          { cause: networkError },
        )
      } else {
        throw new Error(
          `Package '${packageName}' not found on npm. ` +
          `Use \`typediff snapshot\` to create a baseline for first-time publish.`
        )
      }
    } catch (err) {
      if (err instanceof Error && (err.message.includes('not found on npm') || err.message.includes('Failed to reach npm registry'))) {
        throw err
      }
      throw new Error(
        `Failed to check npm registry for '${packageName}': ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  }

  return { packageName, oldVersion, newVersion: version, localPath: absPath }
}

/**
 * Select the correct typesVersions mapping for the active TypeScript version.
 * TypeScript evaluates ranges in declaration order and picks the first match.
 */
function selectTypesVersions(tvMap: Record<string, unknown>): Record<string, unknown> | undefined {
  const tsVersion = ts.version
  for (const [range, mapping] of Object.entries(tvMap)) {
    if (mapping == null || typeof mapping !== 'object') continue
    if (range === '*' || semver.satisfies(tsVersion, range)) {
      return mapping as Record<string, unknown>
    }
  }
  return undefined
}

/**
 * Expand a typesVersions wildcard pattern by scanning the filesystem.
 * e.g. subpath="*" target="types/v4/* /index.d.ts" → scans types/v4/ for directories
 */
function expandTypesVersionsWildcard(
  pkgDir: string,
  subpathPattern: string,
  targetPattern: string,
): Array<{ entryPoint: string; typesPath: string }> {
  const results: Array<{ entryPoint: string; typesPath: string }> = []

  // Find the static prefix of the target pattern before the *
  const starIdx = targetPattern.indexOf('*')
  if (starIdx === -1) return results

  const targetPrefix = targetPattern.slice(0, starIdx)
  const targetSuffix = targetPattern.slice(starIdx + 1)
  const scanDir = resolve(pkgDir, targetPrefix)
  if (!existsSync(scanDir)) return results

  let names: string[]
  try {
    names = readdirSync(scanDir)
  } catch {
    return results
  }

  for (const name of names) {
    const candidateTarget = `${targetPrefix}${name}${targetSuffix}`
    const resolved = resolve(pkgDir, candidateTarget)
    if (!existsSync(resolved)) continue

    const entryPoint = `./${subpathPattern.replace('*', name)}`
    results.push({ entryPoint, typesPath: resolved })
  }

  return results
}

function inferDtsFromJs(jsPath: string): string | undefined {
  const dts = jsPath
    .replace(/\.mjs$/, '.d.mts')
    .replace(/\.cjs$/, '.d.cts')
    .replace(/\.js$/, '.d.ts')
  return dts !== jsPath ? dts : undefined
}

function getExportsTypes(pkg: Record<string, unknown>): string | undefined {
  const exports = pkg.exports
  if (exports == null || typeof exports !== 'object') return undefined

  // If exports is a string, it's the main entry (no types info)
  if (typeof exports === 'string') return undefined

  const exportsObj = exports as Record<string, unknown>

  // Check for subpath exports: exports["."]
  const dotExport = exportsObj['.']
  if (dotExport != null && typeof dotExport === 'object') {
    return findTypesInCondition(dotExport)
  }
  // exports["."] is a string (JS entry with no types condition) — try adjacent .d.ts
  if (typeof dotExport === 'string') {
    return inferDtsFromJs(dotExport)
  }

  // Check for flat condition exports (no "." key, keys are conditions like "types", "import", etc.)
  // Detect this by checking if NO key starts with "."
  const keys = Object.keys(exportsObj)
  const hasSubpaths = keys.some((k) => k.startsWith('.'))
  if (!hasSubpaths) {
    return findTypesInCondition(exportsObj)
  }

  return undefined
}

/**
 * Recursively search a condition object for the first "types" field that is a string.
 *
 * Handles nested conditional exports like:
 *   { "import": { "types": "./dist/index.d.mts" }, "require": { "types": "./dist/index.d.ts" } }
 * as well as flat:
 *   { "types": "./dist/index.d.ts" }
 */
const MAX_CONDITION_DEPTH = 10

const CONDITION_PRIORITY = ['import', 'node', 'default', 'require'] as const

function findTypesInCondition(value: unknown, depth = 0): string | undefined {
  if (value == null || typeof value !== 'object' || depth > MAX_CONDITION_DEPTH) return undefined
  const obj = value as Record<string, unknown>

  if (typeof obj.types === 'string') return obj.types

  for (const key of CONDITION_PRIORITY) {
    const val = obj[key]
    if (val == null) continue
    if (typeof val === 'object') {
      const found = findTypesInCondition(val, depth + 1)
      if (found) return found
    }
    // Condition points to a JS file — infer adjacent .d.ts
    if (typeof val === 'string') {
      const dts = inferDtsFromJs(val)
      if (dts) return dts
    }
  }

  for (const [key, v] of Object.entries(obj)) {
    if (CONDITION_PRIORITY.includes(key as typeof CONDITION_PRIORITY[number])) continue
    if (v != null && typeof v === 'object') {
      const found = findTypesInCondition(v, depth + 1)
      if (found) return found
    }
    if (typeof v === 'string' && !CONDITION_PRIORITY.includes(key as typeof CONDITION_PRIORITY[number])) {
      const dts = inferDtsFromJs(v)
      if (dts) return dts
    }
  }

  return undefined
}
