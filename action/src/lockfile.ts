export interface ChangedPackage {
  name: string
  oldVersion: string
  newVersion: string
}

export type LockfileType = 'npm' | 'yarn' | 'pnpm' | 'bun'

/**
 * Detect the lockfile type from a filename.
 */
export function detectLockfileType(filename: string): LockfileType | null {
  const base = filename.split('/').pop() ?? filename
  switch (base) {
    case 'package-lock.json':
      return 'npm'
    case 'yarn.lock':
      return 'yarn'
    case 'pnpm-lock.yaml':
      return 'pnpm'
    case 'bun.lock':
    case 'bun.lockb':
      return 'bun'
    default:
      return null
  }
}

/**
 * Parse a unified diff of a lockfile and extract changed packages.
 */
export function parseLockfileDiff(diff: string, type: LockfileType): ChangedPackage[] {
  switch (type) {
    case 'npm':
      return parseNpmDiff(diff)
    case 'yarn':
      return parseYarnDiff(diff)
    case 'pnpm':
      return parsePnpmDiff(diff)
    case 'bun':
      return parseBunDiff(diff)
  }
}

/**
 * Parse npm (package-lock.json) diff.
 *
 * Looks for blocks like:
 *   "node_modules/pkg-name": {
 *     -"version": "old"
 *     +"version": "new"
 *     "resolved": "https://..."
 *
 * Skips packages with "resolved": "file:..." or "resolved": "workspace:..."
 */
function parseNpmDiff(diff: string): ChangedPackage[] {
  const lines = diff.split('\n')
  const results: ChangedPackage[] = []

  let currentPkg: string | null = null
  let oldVersion: string | null = null
  let newVersion: string | null = null
  let isWorkspace = false

  // Pattern: "node_modules/pkg" or "node_modules/@scope/pkg"
  // Also match nested entries like "node_modules/parent/node_modules/@scope/child"
  // by capturing only the last node_modules segment.
  const pkgHeaderRe = /^\s*"(?:node_modules\/.*\/)?node_modules\/((?:@[^/]+\/)?[^/"]+)":\s*\{?\s*$/
  // Version lines: -"version": "X" or +"version": "X"
  const oldVersionRe = /^-\s*"version":\s*"([^"]+)"/
  const newVersionRe = /^\+\s*"version":\s*"([^"]+)"/
  // Workspace resolved
  const workspaceResolvedRe = /"resolved":\s*"(file:|workspace:)/

  for (const line of lines) {
    // Check for a new package header (context line, not prefixed with +/-)
    const headerMatch = line.match(pkgHeaderRe)
    if (headerMatch) {
      // Flush previous package if complete
      flushPackage()
      currentPkg = headerMatch[1]
      oldVersion = null
      newVersion = null
      isWorkspace = false
      continue
    }

    if (currentPkg !== null) {
      const oldMatch = line.match(oldVersionRe)
      if (oldMatch) {
        oldVersion = oldMatch[1]
        continue
      }

      const newMatch = line.match(newVersionRe)
      if (newMatch) {
        newVersion = newMatch[1]
        continue
      }

      if (workspaceResolvedRe.test(line)) {
        isWorkspace = true
        continue
      }
    }
  }

  // Flush last package
  flushPackage()

  return results

  function flushPackage() {
    if (currentPkg && oldVersion && newVersion && !isWorkspace) {
      results.push({ name: currentPkg, oldVersion, newVersion })
    }
  }
}

/**
 * Parse yarn (yarn.lock) diff.
 *
 * Looks for removed/added version lines:
 *   -  version "old"
 *   +  version "new"
 *
 * And package name from lines like:
 *   -pkg-name@^x.y.z:
 *   +pkg-name@^x.y.z:
 *
 * Or the context line before version changes.
 */
function parseYarnDiff(diff: string): ChangedPackage[] {
  const lines = diff.split('\n')
  const results: ChangedPackage[] = []

  // We pair removed blocks with added blocks.
  // A removed block starts with -pkgname@... and has -  version "X"
  // An added block starts with +pkgname@... and has +  version "Y"
  let removedPkg: string | null = null
  let removedVersion: string | null = null
  let addedPkg: string | null = null
  let addedVersion: string | null = null

  // Package header: -name@version: or +name@version:
  // Yarn Classic: -pkg@^1.0.0:  |  Yarn Berry: -"pkg@npm:^1.0.0":
  const removedPkgRe = /^-"?((?:@[^@"]+\/)?[^@"\s]+)@.+:\s*$/
  const addedPkgRe = /^\+"?((?:@[^@"]+\/)?[^@"\s]+)@.+:\s*$/
  // Classic: -  version "1.0.0"  |  Berry: -  version: 1.0.0 or -  version: "1.0.0"
  const removedVersionRe = /^-\s+version:?\s+"?([^"\s]+)"?\s*$/
  const addedVersionRe = /^\+\s+version:?\s+"?([^"\s]+)"?\s*$/

  for (const line of lines) {
    const rmPkgMatch = line.match(removedPkgRe)
    if (rmPkgMatch) {
      // Skip workspace entries (e.g., "pkg@workspace:packages/my-pkg")
      if (line.includes('@workspace:')) { removedPkg = null; continue }
      removedPkg = rmPkgMatch[1]
      continue
    }

    const addPkgMatch = line.match(addedPkgRe)
    if (addPkgMatch) {
      if (line.includes('@workspace:')) { addedPkg = null; continue }
      addedPkg = addPkgMatch[1]
      continue
    }

    const rmVerMatch = line.match(removedVersionRe)
    if (rmVerMatch) {
      removedVersion = rmVerMatch[1]
      continue
    }

    const addVerMatch = line.match(addedVersionRe)
    if (addVerMatch) {
      addedVersion = addVerMatch[1]

      // When we have both removed and added, flush
      if (removedPkg && addedPkg && removedVersion && addedVersion && removedPkg === addedPkg) {
        results.push({ name: addedPkg, oldVersion: removedVersion, newVersion: addedVersion })
        removedPkg = null
        removedVersion = null
        addedPkg = null
        addedVersion = null
      }
      continue
    }
  }

  return results
}

/**
 * Parse pnpm (pnpm-lock.yaml) diff.
 *
 * Looks for paired lines:
 *   -  /pkg-name@old-version:
 *   +  /pkg-name@new-version:
 */
function parsePnpmDiff(diff: string): ChangedPackage[] {
  const lines = diff.split('\n')
  const results: ChangedPackage[] = []

  // Pattern: -  /pkg@version: or +  /pkg@version:
  const removedRe = /^-\s*\/?((?:@[^@]+\/)?[^@]+)@([^:]+):\s*$/
  const addedRe = /^\+\s*\/?((?:@[^@]+\/)?[^@]+)@([^:]+):\s*$/

  let removedPkg: string | null = null
  let removedVersion: string | null = null

  for (const line of lines) {
    const rmMatch = line.match(removedRe)
    if (rmMatch) {
      // Strip pnpm peer-dep suffix: 5.17.0(react@18.2.0) → 5.17.0
      const ver = rmMatch[2].replace(/\(.*\)$/, '')
      // Skip workspace/link/file packages — they are local references, not npm versions
      if (ver.startsWith('link:') || ver.startsWith('file:') || ver.startsWith('workspace:')) {
        continue
      }
      removedPkg = rmMatch[1]
      removedVersion = ver
      continue
    }

    const addMatch = line.match(addedRe)
    if (addMatch && removedPkg === addMatch[1] && removedVersion) {
      // Strip pnpm peer-dep suffix: 5.17.0(react@18.2.0) → 5.17.0
      const newVer = addMatch[2].replace(/\(.*\)$/, '')
      if (newVer.startsWith('link:') || newVer.startsWith('file:') || newVer.startsWith('workspace:')) {
        removedPkg = null
        removedVersion = null
        continue
      }
      results.push({
        name: addMatch[1],
        oldVersion: removedVersion,
        newVersion: newVer,
      })
      removedPkg = null
      removedVersion = null
      continue
    }

    // Reset on context lines (not +/- diff lines, not @@ hunk headers)
    if (!line.startsWith('+') && !line.startsWith('-')) {
      removedPkg = null
      removedVersion = null
    }
  }

  return results
}

/**
 * Parse bun (bun.lock) diff.
 *
 * bun.lock is a JSONC file. Package entries look like:
 *   "pkg-name": ["pkg-name@version", ...],
 *
 * We look for paired removed/added lines with the same package key:
 *   -    "zod": ["zod@3.22.0", ...],
 *   +    "zod": ["zod@3.23.0", ...],
 */
function parseBunDiff(diff: string): ChangedPackage[] {
  const lines = diff.split('\n')
  const results: ChangedPackage[] = []

  // Pattern: "pkg-name": ["pkg-name@version", ...
  const entryRe = /^\s*"((?:@[^"]+\/)?[^"]+)":\s*\["(?:(?:@[^"]+\/)?[^"]+)@([^"]+)"/

  let removedPkg: string | null = null
  let removedVersion: string | null = null

  for (const line of lines) {
    if (line.startsWith('-')) {
      const match = line.slice(1).match(entryRe)
      if (match) {
        // Skip workspace/link/file entries (e.g., "workspace:packages/my-pkg")
        if (match[2].startsWith('workspace:') || match[2].startsWith('link:') || match[2].startsWith('file:')) {
          continue
        }
        removedPkg = match[1]
        removedVersion = match[2]
        continue
      }
    }

    if (line.startsWith('+')) {
      const match = line.slice(1).match(entryRe)
      if (match && removedPkg === match[1] && removedVersion) {
        const newVer = match[2]
        if (newVer.startsWith('workspace:') || newVer.startsWith('link:') || newVer.startsWith('file:')) {
          removedPkg = null
          removedVersion = null
          continue
        }
        results.push({
          name: match[1],
          oldVersion: removedVersion,
          newVersion: newVer,
        })
        removedPkg = null
        removedVersion = null
        continue
      }
    }

    // Reset on context lines
    if (!line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@')) {
      removedPkg = null
      removedVersion = null
    }
  }

  return results
}
