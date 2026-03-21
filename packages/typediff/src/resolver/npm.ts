import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import semver from 'semver'
import { resolveLocal, type ResolveResult } from './local.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

// Set up proxy support if HTTPS_PROXY or HTTP_PROXY env vars are present.
// Node 22+ handles this natively; for Node 18-20 we attempt to load undici.
// This promise is awaited before the first network request to avoid a race.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)

const proxyReady: Promise<void> = (proxyUrl && !noProxy.includes('*'))
  ? (async () => {
    try {
      const moduleName = 'undici'
      const undici = await import(/* webpackIgnore: true */ moduleName)
      if (undici.EnvHttpProxyAgent && undici.setGlobalDispatcher) {
        undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent())
      } else if (undici.ProxyAgent && undici.setGlobalDispatcher) {
        undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl))
      }
    } catch (err) {
      // If undici isn't available, proxy support requires Node 22+.
      // If it IS available but setup failed (e.g., malformed proxy URL), warn the user.
      const isModuleNotFound = err instanceof Error &&
        ('code' in err && (err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND')
      if (!isModuleNotFound && proxyUrl) {
        process.stderr.write(`  Warning: proxy setup failed (${err instanceof Error ? err.message : String(err)}). Requests will bypass HTTPS_PROXY.\n`)
      }
    }
  })()
  : Promise.resolve()

export interface NpmResolveOptions {
  registry?: string
}

/**
 * Detect the registry URL from (in priority order):
 * 1. Explicit `registry` option
 * 2. Scoped registry from .npmrc (e.g., @mycompany:registry=https://...)
 * 3. Global registry from .npmrc
 * 4. Default (registry.npmjs.org)
 */
function getRegistry(packageName: string, options?: NpmResolveOptions): string {
  if (options?.registry) return options.registry.replace(/\/$/, '')

  const rcPaths = [
    resolve(process.cwd(), '.npmrc'),
    join(homedir(), '.npmrc'),
  ]

  // Check for scoped registry first (e.g., @mycompany:registry=...)
  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : undefined
  if (scope) {
    for (const rcPath of rcPaths) {
      const scopedReg = readScopedRegistryFromNpmrc(rcPath, scope)
      if (scopedReg) return scopedReg
    }
  }

  // Fall back to global registry
  for (const rcPath of rcPaths) {
    const globalReg = readRegistryFromNpmrc(rcPath)
    if (globalReg) return globalReg
  }

  return DEFAULT_REGISTRY
}

/** Parse global registry from .npmrc content string. */
export function parseRegistryFromNpmrc(content: string): string | undefined {
  const match = content.match(/^\s*registry\s*=\s*(.+)\s*$/m)
  if (match) return match[1].trim().replace(/\/$/, '')
  return undefined
}

/** Parse scoped registry from .npmrc content string. */
export function parseScopedRegistryFromNpmrc(content: string, scope: string): string | undefined {
  const escapedScope = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escapedScope}:registry\\s*=\\s*(.+)\\s*$`, 'm')
  const match = content.match(re)
  if (match) return match[1].trim().replace(/\/$/, '')
  return undefined
}

/** Parse auth token for a given registry from .npmrc content string.
 *  Matches on the full host+path prefix, not just the host, so
 *  path-scoped credentials (e.g. Artifactory repos on the same host) are resolved correctly.
 */
export function parseAuthFromNpmrc(content: string, registryHost: string): { type: 'Bearer' | 'Basic'; token: string } | undefined {
  // Build match candidates: full host+path first (most specific), then host-only (fallback)
  const candidates = [`//${registryHost}`]
  // registryHost may be "host/path" — also try just the host portion as fallback
  const slashIdx = registryHost.indexOf('/')
  if (slashIdx !== -1) {
    candidates.push(`//${registryHost.slice(0, slashIdx)}`)
  }

  for (const prefix of candidates) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue
      // Match prefix followed by / or : to prevent partial hostname matches
      // e.g. //registry.io/ must not match //registry.io.evil.com/
      const idx = trimmed.indexOf(prefix)
      if (idx === -1) continue
      const afterPrefix = trimmed[idx + prefix.length]
      if (afterPrefix !== '/' && afterPrefix !== ':') continue
      if (trimmed.includes(':_authToken=')) {
        const token = trimmed.split(':_authToken=')[1]?.trim()
        if (token) return { type: 'Bearer', token }
      }
      if (trimmed.includes(':_auth=')) {
        const auth = trimmed.split(':_auth=')[1]?.trim()
        if (auth) return { type: 'Basic', token: auth }
      }
    }
  }
  return undefined
}

function readRegistryFromNpmrc(rcPath: string): string | undefined {
  try {
    if (!existsSync(rcPath)) return undefined
    return parseRegistryFromNpmrc(readFileSync(rcPath, 'utf-8'))
  } catch {
    return undefined
  }
}

function readScopedRegistryFromNpmrc(rcPath: string, scope: string): string | undefined {
  try {
    if (!existsSync(rcPath)) return undefined
    return parseScopedRegistryFromNpmrc(readFileSync(rcPath, 'utf-8'), scope)
  } catch {
    return undefined
  }
}

/**
 * Read npm auth token from .npmrc for the given registry.
 * Supports both `//registry.example.com/:_authToken=TOKEN` and
 * `//registry.example.com/:_auth=BASE64` formats.
 */
function getAuthHeaders(registry: string): Record<string, string> {
  const rcPaths = [
    resolve(process.cwd(), '.npmrc'),
    join(homedir(), '.npmrc'),
  ]

  try {
    const url = new URL(registry)
    // Use host+pathname for path-scoped auth matching (e.g. //registry.example.com/repo-b/:_authToken=...)
    const registryHostPath = (url.host + url.pathname).replace(/\/$/, '')
    for (const rcPath of rcPaths) {
      if (!existsSync(rcPath)) continue
      const content = readFileSync(rcPath, 'utf-8')
      const auth = parseAuthFromNpmrc(content, registryHostPath)
      if (auth) return { Authorization: `${auth.type} ${auth.token}` }
    }
  } catch {
    // Can't read .npmrc auth — continue without auth
  }

  return {}
}

function getCacheDir(packageName: string, version: string, registry?: string): string {
  const safeName = packageName.replace(/\//g, '__').replace(/^@/, '')
  if (registry && registry !== DEFAULT_REGISTRY) {
    // Include a registry hash to isolate caches across different registries
    const regHash = createHash('sha256').update(registry).digest('hex').slice(0, 8)
    return join(tmpdir(), 'typediff-cache', `${safeName}@${version}_${regHash}`)
  }
  return join(tmpdir(), 'typediff-cache', `${safeName}@${version}`)
}

/**
 * Fetch with retry and timeout. Respects HTTPS_PROXY/HTTP_PROXY/NO_PROXY
 * environment variables on Node 22+. For older Node versions, use --registry
 * to point to a proxy-accessible registry mirror.
 */
async function fetchWithRetry(url: string, extraHeaders?: Record<string, string>, maxRetries = 3): Promise<Response> {
  await proxyReady
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    let response: Response
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: extraHeaders,
      })
    } catch (err: unknown) {
      clearTimeout(timeout)
      if (attempt < maxRetries) {
        const delay = 2 ** attempt * 1000
        await new Promise((r) => { setTimeout(r, delay) })
        continue
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Request to npm registry timed out after ${maxRetries + 1} attempts. Check your internet connection.`,
          { cause: err },
        )
      }
      const code = (err as NodeJS.ErrnoException).code
      const host = (() => { try { return new URL(url).host } catch { return url } })()
      if (code === 'ENOTFOUND') {
        throw new Error(
          `DNS lookup failed for ${host}. Check your registry URL or network configuration.`,
          { cause: err },
        )
      }
      if (code === 'ECONNREFUSED') {
        throw new Error(
          `Connection refused to ${host}. The registry may be down or unreachable.`,
          { cause: err },
        )
      }
      throw new Error(
        `Could not reach npm registry after ${maxRetries + 1} attempts. Check your internet connection.`,
        { cause: err },
      )
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 429 || response.status === 503) {
      if (attempt === maxRetries) {
        throw new Error(
          `npm registry rate limit after ${maxRetries + 1} attempts`,
        )
      }
      const retryAfter = response.headers.get('retry-after')
      const parsedRetry = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delay = !isNaN(parsedRetry)
        ? Math.min(parsedRetry * 1000, 30_000)
        : 2 ** attempt * 1000
      await new Promise((r) => { setTimeout(r, delay) })
      continue
    }

    return response
  }
  throw new Error('Unreachable')
}

export async function resolveNpm(
  packageName: string,
  version: string,
  options?: NpmResolveOptions,
): Promise<ResolveResult> {
  const registry = getRegistry(packageName, options)
  const cacheDir = getCacheDir(packageName, version, registry)

  // Check cache
  if (existsSync(join(cacheDir, 'package.json'))) {
    try {
      return resolveLocal(cacheDir)
    } catch {
      // Cache is corrupted or incomplete — re-download
      try { rmSync(cacheDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  // Fetch package metadata from npm registry
  await downloadAndExtract(packageName, version, cacheDir, options)

  try {
    return resolveLocal(cacheDir)
  } catch {
    // No types found in main package — try @types fallback
    // Use the package's major version to find a corresponding @types version,
    // since DefinitelyTyped aligns major versions with the source package.
    if (!packageName.startsWith('@types/')) {
      const typesPackageName = getTypesPackageName(packageName)
      try {
        return await resolveNpm(typesPackageName, 'latest', options)
      } catch {
        throw new Error(
          `No type definitions found for ${packageName}@${version}. ` +
            `Also tried ${typesPackageName} but it was not available.`,
        )
      }
    }
    throw new Error(`No type definitions found for ${packageName}@${version}`)
  }
}

async function extractTarGz(tgzPath: string, destDir: string): Promise<void> {
  const { createGunzip } = await import('node:zlib')
  const { createReadStream } = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')
  const { Writable } = await import('node:stream')

  // tar header field offsets and sizes (POSIX ustar format)
  const TAR_BLOCK = 512
  const TAR_NAME_END = 100
  const TAR_MODE_START = 100
  const TAR_MODE_END = 108
  const TAR_SIZE_START = 124
  const TAR_SIZE_END = 136
  const TAR_TYPE_OFFSET = 156
  const TAR_PREFIX_START = 345
  const TAR_PREFIX_END = 500
  const TYPE_FILE = 48      // ASCII '0'
  const TYPE_FILE_OLD = 0   // legacy tar format
  const DEFAULT_MODE = 0o644
  const resolvedDest = resolve(destDir)

  function stripNulls(s: string): string {
    const idx = s.indexOf(String.fromCharCode(0))
    return idx === -1 ? s : s.slice(0, idx)
  }

  /** Write a file to disk immediately instead of buffering in memory. */
  function writeEntry(path: string, data: Buffer, mode: number): void {
    const fullPath = resolve(destDir, path)
    if (!fullPath.startsWith(resolvedDest + sep)) return // path traversal guard
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, data, { mode })
  }

  let buf = Buffer.alloc(0)
  let pending: { path: string; size: number; mode: number } | null = null

  const tarParser = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buf = Buffer.concat([buf, chunk])

      while (buf.length >= TAR_BLOCK) {
        if (pending) {
          if (buf.length >= pending.size) {
            const data = buf.subarray(0, pending.size)
            const padded = Math.ceil(pending.size / TAR_BLOCK) * TAR_BLOCK
            buf = buf.subarray(padded)
            if (pending.path) {
              writeEntry(pending.path, Buffer.from(data), pending.mode)
            }
            pending = null
            continue
          }
          break
        }

        const header = buf.subarray(0, TAR_BLOCK)
        if (header.every((b: number) => b === 0)) {
          buf = buf.subarray(TAR_BLOCK)
          continue
        }

        const nameRaw = stripNulls(header.subarray(0, TAR_NAME_END).toString('utf-8'))
        const sizeOctal = stripNulls(header.subarray(TAR_SIZE_START, TAR_SIZE_END).toString('utf-8')).trim()
        const typeFlag = header[TAR_TYPE_OFFSET]
        const prefix = stripNulls(header.subarray(TAR_PREFIX_START, TAR_PREFIX_END).toString('utf-8'))
        const modeOctal = stripNulls(header.subarray(TAR_MODE_START, TAR_MODE_END).toString('utf-8')).trim()

        const fullName = prefix ? `${prefix}/${nameRaw}` : nameRaw
        const size = parseInt(sizeOctal, 8) || 0
        const mode = parseInt(modeOctal, 8) || DEFAULT_MODE

        buf = buf.subarray(TAR_BLOCK)

        // Strip first path component (equivalent to --strip-components=1)
        const stripped = fullName.split('/').slice(1).join('/')
        const isFile = (typeFlag === TYPE_FILE || typeFlag === TYPE_FILE_OLD) && stripped

        if (isFile) {
          if (size === 0) {
            // Zero-byte file — write immediately, no data blocks to consume
            writeEntry(stripped, Buffer.alloc(0), mode)
          } else {
            const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
            if (buf.length >= padded) {
              writeEntry(stripped, Buffer.from(buf.subarray(0, size)), mode)
              buf = buf.subarray(padded)
            } else {
              pending = { path: stripped, size, mode }
            }
          }
        } else if (size > 0) {
          const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
          if (buf.length >= padded) {
            buf = buf.subarray(padded)
          } else {
            pending = { path: '', size, mode: 0 }
          }
        }
      }
      callback()
    },
  })

  await pipeline(
    createReadStream(tgzPath),
    createGunzip(),
    tarParser,
  )
}

async function downloadAndExtract(
  packageName: string,
  version: string,
  cacheDir: string,
  options?: NpmResolveOptions,
): Promise<void> {
  const registry = getRegistry(packageName, options)
  const authHeaders = getAuthHeaders(registry)

  // Fetch metadata
  const metaUrl = `${registry}/${encodeURIComponent(packageName).replace('%40', '@')}/${encodeURIComponent(version)}`
  const metaRes = await fetchWithRetry(metaUrl, authHeaders)

  if (metaRes.status === 404) {
    throw new Error(
      `Package "${packageName}@${version}" not found on npm. Check the package name and version.`,
    )
  }

  if (!metaRes.ok) {
    throw new Error(
      `Failed to fetch package metadata for ${packageName}@${version}: ${metaRes.status} ${metaRes.statusText}`,
    )
  }

  const meta = (await metaRes.json()) as { dist?: { tarball?: string; integrity?: string } }
  const tarballUrl = meta.dist?.tarball
  if (!tarballUrl) {
    throw new Error(
      `No tarball URL found in registry metadata for ${packageName}@${version}`,
    )
  }

  // Only forward auth headers if tarball is hosted on the same registry —
  // prevents leaking tokens to third-party CDN/storage hosts
  const tarballHost = new URL(tarballUrl).host
  const registryHost = new URL(registry).host
  const tarHeaders = tarballHost === registryHost ? authHeaders : {}
  const tarRes = await fetchWithRetry(tarballUrl, tarHeaders)
  if (!tarRes.ok) {
    throw new Error(
      `Failed to download tarball for ${packageName}@${version}: ${tarRes.status}`,
    )
  }

  const tarballBuffer = Buffer.from(await tarRes.arrayBuffer())

  // Verify tarball integrity if the registry provided a hash
  const expectedIntegrity = meta.dist?.integrity
  if (expectedIntegrity) {
    const dashIdx = expectedIntegrity.indexOf('-')
    if (dashIdx !== -1) {
      const algo = expectedIntegrity.slice(0, dashIdx)
      const expectedHash = expectedIntegrity.slice(dashIdx + 1)
      try {
        const actualHash = createHash(algo).update(tarballBuffer).digest('base64')
        if (actualHash !== expectedHash) {
          throw new Error(
            `Tarball integrity check failed for ${packageName}@${version}. ` +
            `Expected ${expectedIntegrity}`,
          )
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('integrity check failed')) throw err
        // Unknown hash algorithm — skip verification
      }
    }
  }

  // Download and extract to a staging directory, then atomically move to cache.
  // This prevents concurrent processes from seeing a half-extracted cache.
  const stagingDir = join(dirname(cacheDir), `.staging-${randomUUID()}`)
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 })

  try {
    const tgzPath = join(stagingDir, 'package.tgz')
    writeFileSync(tgzPath, tarballBuffer)

    try {
      execFileSync('tar', ['-xzf', 'package.tgz', '--strip-components=1'], {
        cwd: stagingDir,
      })
    } catch {
      // Fallback: extract using Node.js built-in zlib (Windows compat)
      await extractTarGz(tgzPath, stagingDir)
    }

    // Atomic move from staging to cache (same filesystem, so rename is atomic)
    // If the cache dir already exists (another process won the race), use it
    if (!existsSync(join(cacheDir, 'package.json'))) {
      mkdirSync(dirname(cacheDir), { recursive: true, mode: 0o700 })
      try {
        renameSync(stagingDir, cacheDir)
      } catch {
        // Another process created it between our check and rename — that's fine
      }
    }
  } finally {
    // Clean up staging dir if it still exists (rename failed or wasn't attempted)
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true })
    }
  }
}

export async function getPreviousVersion(
  packageName: string,
  currentVersion: string,
  options?: NpmResolveOptions,
): Promise<string | null> {
  const registry = getRegistry(packageName, options)
  const authHeaders = getAuthHeaders(registry)
  const registryUrl = `${registry}/${encodeURIComponent(packageName).replace('%40', '@')}`
  const response = await fetchWithRetry(registryUrl, authHeaders)
  if (!response.ok) {
    if (response.status === 404) return null
    throw new Error(`npm registry returned ${response.status} for ${packageName}`)
  }

  const metadata = (await response.json()) as { versions?: Record<string, unknown> }
  const versions = Object.keys(metadata.versions ?? {})

  // Include stable versions and prereleases that share the same base version as currentVersion.
  // This ensures 1.0.0-beta.2 finds 1.0.0-beta.1 as its previous, not 0.9.0.
  const currentParsed = semver.parse(currentVersion)
  const currentBase = currentParsed ? `${currentParsed.major}.${currentParsed.minor}.${currentParsed.patch}` : null
  const isCurrentPrerelease = currentParsed && currentParsed.prerelease.length > 0

  const sorted = versions
    .filter((v) => {
      if (!semver.valid(v)) return false
      const pre = semver.prerelease(v)
      if (!pre) return true // stable versions always included
      if (v === currentVersion) return true
      // Include prereleases that share the same base version when current is also a prerelease
      if (isCurrentPrerelease && currentBase) {
        const parsed = semver.parse(v)
        if (parsed && `${parsed.major}.${parsed.minor}.${parsed.patch}` === currentBase) return true
      }
      return false
    })
    .sort(semver.compare)

  const currentIndex = sorted.indexOf(currentVersion)
  if (currentIndex <= 0) return null

  return sorted[currentIndex - 1]
}

export async function getLatestVersion(
  packageName: string,
  options?: NpmResolveOptions,
): Promise<string | null> {
  const registry = getRegistry(packageName, options)
  const authHeaders = getAuthHeaders(registry)
  const registryUrl = `${registry}/${encodeURIComponent(packageName).replace('%40', '@')}`
  const response = await fetchWithRetry(registryUrl, authHeaders)
  if (!response.ok) {
    if (response.status === 404) return null
    throw new Error(`npm registry returned ${response.status} for ${packageName}`)
  }
  const metadata = (await response.json()) as { 'dist-tags'?: Record<string, string> }
  return metadata['dist-tags']?.latest ?? null
}

function getTypesPackageName(packageName: string): string {
  if (packageName.startsWith('@')) {
    // @scope/pkg -> @types/scope__pkg
    const withoutAt = packageName.slice(1)
    return `@types/${withoutAt.replace('/', '__')}`
  }
  return `@types/${packageName}`
}
