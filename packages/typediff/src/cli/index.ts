#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { diff, diffLocal, diffMixed } from '../index.js'
import { resolveLocalAuto } from '../resolver/local.js'
import { SEVERITY_ORDER, type ChangeSet, type SemverLevel, type TypediffOptions } from '../core/types.js'
import { getPreviousVersion } from '../resolver/npm.js'
import { formatJson } from './formatters/json.js'
import { formatPretty } from './formatters/pretty.js'
import { createSpinner } from './spinner.js'
import { getVersion } from '../core/version.js'

const HELP = `
typediff - Verify semver accuracy by diffing TypeScript types

Usage:
  typediff inspect <pkg@version>             (auto-detect previous version)
  typediff inspect <pkg@old> <pkg@new>
  typediff inspect ./local-path <pkg@version>
  typediff snapshot <path> [-o <file>]
  typediff compare <snapshot.json> <path-or-pkg@version>
  typediff --workspaces                      (scan all workspace packages)

Options:
  --format <json|pretty>   Output format (default: auto-detect TTY)
  --json                   Shorthand for --format json
  --severity <level>       Minimum severity: major, minor, patch
  --ignore <pattern>       Glob pattern to ignore (repeatable)
  --respect-tags           Honor @internal/@beta/@public TSDoc tags
  --verbose                Show all changes including compatible ones
  --quiet, -q              One-line verdict output
  --exit-code              Exit 1 if breaking changes found
  --include-internals      Include _-prefixed internal members
  --workspaces             Scan all workspace packages
  --filter <glob>          Filter workspaces (with --workspaces)
  --registry <url>         Custom npm registry URL (also reads .npmrc)
  --debug                  Show diagnostic debug output
  -h, --help               Show this help
  -v, --version            Show version

Exit codes:
  0  Success (or no breaking changes with --exit-code)
  1  Breaking changes detected (with --exit-code)
  2  Operational error
`.trim()

interface RcConfig {
  format?: string
  severity?: string
  ignore?: string[]
  exitCode?: boolean
  respectTags?: boolean
  quiet?: boolean
}

function loadRcConfig(): RcConfig {
  const rcPath = resolve(process.cwd(), '.typediffrc.json')
  if (!existsSync(rcPath)) return {}
  try {
    const content = readFileSync(rcPath, 'utf-8')
    const rc = JSON.parse(content) as Record<string, unknown>
    // Validate fields at load time so errors point to the rc file, not CLI logic
    if (rc.severity != null && !['major', 'minor', 'patch'].includes(rc.severity as string)) {
      console.error(`Warning: Invalid severity "${rc.severity}" in ${rcPath}. Must be major, minor, or patch.`)
      delete rc.severity
    }
    if (rc.format != null && !['json', 'pretty'].includes(rc.format as string)) {
      console.error(`Warning: Invalid format "${rc.format}" in ${rcPath}. Must be json or pretty.`)
      delete rc.format
    }
    return rc as RcConfig
  } catch (err) {
    console.error(`Warning: Failed to parse ${rcPath}: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

import { parseSpec, isLocalPath } from './utils.js'

function shouldExitWithError(actualSemver: SemverLevel, severityThreshold?: SemverLevel, changeCount?: number): boolean {
  // No changes at all — nothing to fail on regardless of threshold
  if (changeCount !== undefined && changeCount === 0) return false
  const threshold = severityThreshold ?? 'major'
  return SEVERITY_ORDER[actualSemver] >= SEVERITY_ORDER[threshold]
}

function formatAndExit(
  results: ChangeSet[],
  opts: {
    format: 'json' | 'pretty'
    quiet: boolean
    verbose: boolean
    exitCode: boolean
    severity?: SemverLevel
    startTime: number
  },
): void {
  const output = opts.format === 'json'
    ? formatJson(results, { quiet: opts.quiet })
    : formatPretty(results, { verbose: opts.verbose, quiet: opts.quiet, elapsedMs: performance.now() - opts.startTime })
  console.log(output)
  if (opts.exitCode && results.some(r => shouldExitWithError(r.actualSemver, opts.severity, r.changes.length))) {
    process.exit(1)
  }
  process.exit(0)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: 'string', short: 'f' },
      json: { type: 'boolean' },
      output: { type: 'string', short: 'o' },
      severity: { type: 'string', short: 's' },
      ignore: { type: 'string', multiple: true },
      verbose: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      'respect-tags': { type: 'boolean' },
      'include-internals': { type: 'boolean' },
      'exit-code': { type: 'boolean' },
      workspaces: { type: 'boolean' },
      filter: { type: 'string' },
      registry: { type: 'string' },
      debug: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })

  if (values.help) {
    console.log(HELP)
    process.exit(0)
  }

  if (values.version) {
    console.log(getVersion())
    process.exit(0)
  }

  const rc = loadRcConfig()

  // Merge: CLI flags override rc config
  const format = (values.json ? 'json' : values.format ?? rc.format ?? (process.stdout.isTTY ? 'pretty' : 'json')) as 'json' | 'pretty'
  const severity = (values.severity ?? rc.severity) as SemverLevel | undefined
  const ignore = values.ignore ?? rc.ignore ?? []
  const quiet = values.quiet ?? rc.quiet ?? false
  const verbose = values.verbose ?? false
  const effectiveVerbose = quiet ? false : verbose
  const exitCode = values['exit-code'] ?? rc.exitCode ?? false
  const respectTags = values['respect-tags'] ?? rc.respectTags ?? false

  const validSeverities = ['major', 'minor', 'patch']
  if (severity && !validSeverities.includes(severity)) {
    console.error(`Error: Invalid severity "${severity}". Must be one of: major, minor, patch`)
    process.exit(2)
  }

  const validFormats = ['json', 'pretty']
  if (format && !validFormats.includes(format)) {
    console.error(`Error: Invalid format "${format}". Must be one of: json, pretty`)
    process.exit(2)
  }

  const [command, ...args] = positionals
  const startTime = performance.now()

  const includeInternals = values['include-internals'] ?? false
  const debug = values.debug ?? false

  const typediffOptions: TypediffOptions = {
    onWarn: (msg) => console.error(`  Warning: ${msg}`),
    onDebug: debug ? (msg) => console.error(`  [debug] ${msg}`) : undefined,
  }
  if (severity) typediffOptions.severity = severity
  if (ignore.length > 0) typediffOptions.ignore = ignore
  if (respectTags) typediffOptions.respectTags = true
  if (includeInternals) typediffOptions.includeInternals = true
  if (values.registry) typediffOptions.registry = values.registry as string

  // --workspaces doesn't require a command
  if (values.workspaces) {
    const { runWorkspaces } = await import('./commands/workspaces.js')
    const wsResults = await runWorkspaces(typediffOptions, values.filter as string | undefined)
    if (wsResults.length === 0) {
      console.error('No publishable workspaces found')
      process.exit(0)
    }
    formatAndExit(wsResults, { format, quiet, verbose: effectiveVerbose, exitCode, severity, startTime })
  }

  if (!command) {
    console.error('Error: No command specified. Run "typediff --help" for usage.')
    process.exit(2)
  }

  if (command === 'snapshot') {
    const outputFile = values.output as string | undefined
    const snapshotArgs = positionals.slice(1)
    const { runSnapshot } = await import('./commands/snapshot.js')
    await runSnapshot(snapshotArgs, outputFile)
    process.exit(0)
  }

  if (command === 'compare') {
    if (args.length < 2) {
      console.error('Error: compare requires two arguments: <snapshot.json> <path-or-pkg@version>')
      process.exit(2)
    }
    const { runCompare } = await import('./commands/compare.js')
    const compareResult = await runCompare(args[0], args[1], typediffOptions)
    formatAndExit([compareResult], { format, quiet, verbose: effectiveVerbose, exitCode, severity, startTime })
  }

  if (command !== 'inspect') {
    console.error(`Error: Unknown command "${command}". Run "typediff --help" for usage.`)
    process.exit(2)
  }

  if (args.length < 1) {
    console.error('Error: inspect requires at least one argument: <pkg@version>')
    process.exit(2)
  }

  if (args.length > 2) {
    console.error(`Warning: ignoring extra arguments: ${args.slice(2).join(', ')}`)
  }

  let oldSpec: string
  let newSpec: string

  if (args.length === 1) {
    // Single-version mode: auto-detect previous version
    const spec = args[0]

    if (isLocalPath(spec)) {
      // Auto-detect local package
      const spinner0 = effectiveVerbose ? null : createSpinner()
      let auto: Awaited<ReturnType<typeof resolveLocalAuto>>
      try {
        if (spinner0) spinner0.start('Detecting package...')
        else if (effectiveVerbose) console.error('  Detecting package...')
        auto = await resolveLocalAuto(spec, typediffOptions.registry ? { registry: typediffOptions.registry } : undefined)
      } finally {
        spinner0?.stop()
      }

      const spinner = effectiveVerbose ? null : createSpinner()
      typediffOptions.onProgress = spinner
        ? (msg) => spinner.start(msg)
        : (msg) => console.error(`  ${msg}`)

      if (spinner) spinner.start(`Comparing against ${auto.packageName}@${auto.oldVersion}...`)
      else if (effectiveVerbose) console.error(`  Comparing against ${auto.packageName}@${auto.oldVersion}...`)
      const result = await diffMixed(spec, auto.packageName, auto.oldVersion, false, typediffOptions)
      spinner?.stop()
      formatAndExit([result], { format, quiet, verbose: effectiveVerbose, exitCode, severity, startTime })
    }

    const parsed = parseSpec(spec)
    if (!parsed) {
      console.error(`Error: Invalid package spec "${spec}". Expected format: pkg@version`)
      process.exit(2)
    }

    const spinner0 = effectiveVerbose ? null : createSpinner()
    let prevVersion: string | null
    try {
      if (spinner0) spinner0.start(`Finding previous version of ${parsed.name}...`)
      else if (effectiveVerbose) console.error(`  Finding previous version of ${parsed.name}...`)
      prevVersion = await getPreviousVersion(parsed.name, parsed.version, typediffOptions.registry ? { registry: typediffOptions.registry } : undefined)
    } finally {
      spinner0?.stop()
    }

    if (!prevVersion) {
      console.error(`Could not determine previous version for ${parsed.name}@${parsed.version}`)
      process.exit(2)
    }

    oldSpec = `${parsed.name}@${prevVersion}`
    newSpec = spec
  } else {
    oldSpec = args[0]
    newSpec = args[1]
  }
  const spinner = effectiveVerbose ? null : createSpinner()
  typediffOptions.onProgress = spinner
    ? (msg) => spinner.start(msg)
    : (msg) => console.error(`  ${msg}`)

  try {
    let result: ChangeSet

    if (isLocalPath(oldSpec) && isLocalPath(newSpec)) {
      // Both local paths
      result = await diffLocal(oldSpec, newSpec, typediffOptions)
    } else if (isLocalPath(oldSpec) || isLocalPath(newSpec)) {
      // Mixed: one local, one npm
      const localPath = isLocalPath(oldSpec) ? oldSpec : newSpec
      const npmSpec = isLocalPath(oldSpec) ? newSpec : oldSpec
      const localIsOld = isLocalPath(oldSpec)

      const parsed = parseSpec(npmSpec)
      if (!parsed) {
        console.error(`Error: Invalid package spec "${npmSpec}". Expected format: pkg@version`)
        process.exit(2)
      }

      result = await diffMixed(localPath, parsed.name, parsed.version, localIsOld, typediffOptions)
    } else {
      // Both npm specs
      const oldParsed = parseSpec(oldSpec)
      const newParsed = parseSpec(newSpec)

      if (!oldParsed) {
        console.error(`Error: Invalid package spec "${oldSpec}". Expected format: pkg@version`)
        process.exit(2)
      }
      if (!newParsed) {
        console.error(`Error: Invalid package spec "${newSpec}". Expected format: pkg@version`)
        process.exit(2)
      }
      if (oldParsed.name !== newParsed.name) {
        console.error(`Error: Package names must match. Got "${oldParsed.name}" and "${newParsed.name}".`)
        process.exit(2)
      }

      result = await diff(oldParsed.name, oldParsed.version, newParsed.version, typediffOptions)
    }

    spinner?.stop()
    formatAndExit([result], { format, quiet, verbose: effectiveVerbose, exitCode, severity, startTime })
  } catch (err) {
    spinner?.stop()
    throw err // re-throw to the top-level handler
  }
}

// Clean up on interrupt — stop spinner, restore cursor, exit cleanly
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.stderr.write('\x1b[?25h')
    process.exit(SIGNAL_EXIT_CODES[signal])
  })
}

main().catch((err) => {
  if (err instanceof Error && err.name === 'AbortError') {
    console.error('  Request timed out. Check your internet connection.')
  } else {
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`)
  }
  process.exit(2)
})
