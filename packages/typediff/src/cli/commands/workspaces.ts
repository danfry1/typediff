import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { minimatch } from 'minimatch'
import type { ChangeSet, TypediffOptions } from '../../core/types.js'
import { resolveLocalAuto } from '../../resolver/local.js'
import { diffMixed } from '../../index.js'

interface DirCandidate {
  relative: string
  absolute: string
}

/** Recursively walk directories, returning relative paths suitable for glob matching. */
function walkDirectories(
  dir: string,
  root: string,
  prefix: string,
  maxDepth = 10,
  currentDepth = 0,
): DirCandidate[] {
  if (currentDepth >= maxDepth) {
    console.error(`  Warning: workspace scan reached depth limit (${maxDepth}) at ${dir}`)
    return []
  }
  const results: DirCandidate[] = []

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return results
  }

  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const absPath = join(dir, name)
    try {
      if (!statSync(absPath).isDirectory()) continue
    } catch {
      continue
    }
    const relPath = prefix ? `${prefix}${name}` : name
    results.push({ relative: relPath, absolute: absPath })

    // Recurse into subdirectories
    const deeper = walkDirectories(absPath, root, `${relPath}/`, maxDepth, currentDepth + 1)
    results.push(...deeper)
  }

  return results
}

export interface WorkspaceInfo {
  name: string
  version: string
  path: string
}

export function resolveWorkspaces(rootDir: string, filter?: string): WorkspaceInfo[] {
  const absRoot = resolve(rootDir)
  const rootPkgPath = join(absRoot, 'package.json')
  if (!existsSync(rootPkgPath)) {
    throw new Error('No package.json found in current directory')
  }
  let rootPkg: Record<string, unknown>
  try {
    rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'))
  } catch {
    throw new Error(`Failed to parse package.json in ${absRoot}`)
  }

  let workspaceGlobs: string[] = []
  const ws = rootPkg.workspaces
  if (Array.isArray(ws)) {
    workspaceGlobs = ws as string[]
  } else if (ws && typeof ws === 'object' && Array.isArray((ws as Record<string, unknown>).packages)) {
    workspaceGlobs = (ws as Record<string, unknown>).packages as string[]
  }

  if (workspaceGlobs.length === 0) {
    throw new Error('No workspaces field found in root package.json')
  }

  const workspaceDirSet = new Set<string>()
  for (const glob of workspaceGlobs) {
    // Find the static prefix before any glob characters
    const firstGlobChar = glob.search(/[*?{[]/)
    if (firstGlobChar === -1) {
      // No glob characters — treat as literal directory
      const dirPath = join(absRoot, glob)
      if (existsSync(dirPath)) {
        workspaceDirSet.add(dirPath)
      }
      continue
    }

    // Walk the directory tree from the static prefix and match against the glob
    const prefix = glob.slice(0, glob.lastIndexOf('/', firstGlobChar) + 1) || '.'
    const prefixPath = join(absRoot, prefix)
    if (!existsSync(prefixPath)) continue

    // Recursively find all directories under the prefix and match against the glob
    const candidates = walkDirectories(prefixPath, absRoot, prefix)
    for (const candidate of candidates) {
      if (minimatch(candidate.relative, glob)) {
        workspaceDirSet.add(candidate.absolute)
      }
    }
  }
  const workspaceDirs = [...workspaceDirSet]

  const results: WorkspaceInfo[] = []
  for (const dir of workspaceDirs) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue

    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    } catch {
      continue
    }
    if (pkg.private === true) continue

    const name = pkg.name as string | undefined
    const version = pkg.version as string | undefined
    if (!name || !version) continue

    if (filter) {
      const relPath = relative(absRoot, dir)
      if (!minimatch(relPath, filter)) continue
    }

    results.push({ name, version, path: dir })
  }

  return results
}

export async function runWorkspaces(
  options: TypediffOptions,
  filter?: string,
  rootDir: string = process.cwd(),
): Promise<ChangeSet[]> {
  const workspaces = resolveWorkspaces(rootDir, filter)
  const results: ChangeSet[] = []
  let skippedUnpublished = 0
  let skippedErrors = 0

  // Process workspaces in parallel batches of 4
  const BATCH_SIZE = 4
  const npmOptions = options.registry ? { registry: options.registry } : undefined
  for (let i = 0; i < workspaces.length; i += BATCH_SIZE) {
    const batch = workspaces.slice(i, i + BATCH_SIZE)
    const settled = await Promise.allSettled(
      batch.map(async (ws) => {
        const auto = await resolveLocalAuto(ws.path, npmOptions)
        return diffMixed(ws.path, auto.packageName, auto.oldVersion, false, options)
      }),
    )

    for (let j = 0; j < settled.length; j++) {
      const result = settled[j]
      const ws = batch[j]
      if (result.status === 'fulfilled') {
        results.push(result.value)
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        if (message.includes('not found on npm') || message.includes('No type definitions found')) {
          skippedUnpublished++
        } else {
          skippedErrors++
          console.error(`  Warning: skipping ${ws.name} (${ws.path}): ${message}`)
        }
      }
    }
  }

  if (skippedUnpublished > 0 || skippedErrors > 0) {
    const parts: string[] = []
    if (skippedUnpublished > 0) parts.push(`${skippedUnpublished} unpublished`)
    if (skippedErrors > 0) parts.push(`${skippedErrors} failed`)
    console.error(`  Skipped ${parts.join(', ')} of ${workspaces.length} workspace(s)`)
  }

  if (results.length === 0 && skippedErrors > 0) {
    throw new Error(
      `All ${workspaces.length} workspace(s) failed during comparison (${skippedErrors} error(s))`,
    )
  }

  return results
}
