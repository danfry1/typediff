import { SEVERITY_ORDER, type Change, type ChangeSet } from '../../core/types.js'
import { addedLabel, removedLabel, changedLabel } from '../../core/labels.js'

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true
  return process.stdout.isTTY === true
}

const useColor = shouldUseColor()

const c = {
  red: (s: string) => useColor ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: (s: string) => useColor ? `\x1b[33m${s}\x1b[0m` : s,
  green: (s: string) => useColor ? `\x1b[32m${s}\x1b[0m` : s,
  dim: (s: string) => useColor ? `\x1b[2m${s}\x1b[0m` : s,
  bold: (s: string) => useColor ? `\x1b[1m${s}\x1b[0m` : s,
  cyan: (s: string) => useColor ? `\x1b[36m${s}\x1b[0m` : s,
  bgRed: (s: string) => useColor ? `\x1b[41m\x1b[97m${s}\x1b[0m` : s,
  bgYellow: (s: string) => useColor ? `\x1b[43m\x1b[30m${s}\x1b[0m` : s,
  bgGreen: (s: string) => useColor ? `\x1b[42m\x1b[30m${s}\x1b[0m` : s,
}

// ── Constants ───────────────────────────────────────────────────────────────

const INDENT = '  '
const MAX_DISPLAY = 5

export interface PrettyFormatOptions {
  verbose?: boolean
  quiet?: boolean
  elapsedMs?: number
}

// ── Change formatting helpers ───────────────────────────────────────────────

function kindPrefix(change: Change): string {
  if (change.semver === 'major') return c.red('\u2716')
  if (change.kind === 'added') return c.yellow('+')
  if (change.kind === 'removed') return c.yellow('\u2212')
  return c.yellow('~')
}

function patchPrefix(change: Change): string {
  if (change.kind === 'added') return c.green('+')
  if (change.kind === 'removed') return c.dim('\u2212')
  return c.dim('~')
}

function changeLabel(change: Change): string {
  const node = change.newNode ?? change.oldNode
  const kind = node?.kind ?? ''

  if (change.kind === 'added') return addedLabel(kind)
  if (change.kind === 'removed') return removedLabel(kind)
  return changedLabel(kind)
}

/** Truncate a string to max visible characters. */
function truncSig(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026'
}

function formatMemberList(lines: string[], label: string, members: string[]): void {
  if (members.length <= 6) {
    lines.push(`${INDENT}  ${c.dim(label)} ${members.join(' | ')}`)
  } else {
    lines.push(`${INDENT}  ${c.dim(label)} ${members.slice(0, 5).join(' | ')} and ${members.length - 5} more`)
  }
}

function formatBreakingChange(change: Change): string[] {
  const lines: string[] = []
  lines.push(`${INDENT}${c.red('\u2716')} ${c.bold(change.path)}`)
  lines.push(`${INDENT}  ${change.description}`)

  // Show specific union diff details when available
  if (change.details?.addedMembers && change.details.addedMembers.length > 0) {
    formatMemberList(lines, 'Added:', change.details.addedMembers)
  }
  if (change.details?.changedMembers && change.details.changedMembers.length > 0) {
    const withReason = change.details.changedMembers.map(m => `${m} (shape modified)`)
    formatMemberList(lines, 'Changed:', withReason)
  }
  if (change.details?.removedMembers && change.details.removedMembers.length > 0) {
    formatMemberList(lines, 'Removed:', change.details.removedMembers)
  }

  // Show signature diff for non-union breaking changes
  if (!change.details) {
    if (change.oldSignature && change.newSignature) {
      lines.push(`${INDENT}  ${c.dim(truncSig(change.oldSignature, 60))} \u2192 ${truncSig(change.newSignature, 60)}`)
    } else if (change.oldSignature) {
      lines.push(`${INDENT}  ${c.dim('was:')} ${truncSig(change.oldSignature, 80)}`)
    } else if (change.newSignature) {
      lines.push(`${INDENT}  ${c.dim('now:')} ${truncSig(change.newSignature, 80)}`)
    }
  }

  return lines
}

function formatMinorChange(change: Change): string {
  const prefix = kindPrefix(change)
  const label = changeLabel(change)
  const pathStr = change.path
  const reason = change.reason ? c.dim(`  (${change.reason})`) : ''
  return `${INDENT}${prefix} ${pathStr}${c.dim('  ' + label)}${reason}`
}

function formatPatchChange(change: Change): string {
  const prefix = patchPrefix(change)
  const label = changeLabel(change)
  const reason = change.reason ? c.dim(`  (${change.reason})`) : ''
  return `${INDENT}${prefix} ${change.path}${c.dim('  ' + label)}${reason}`
}

// ── Main formatter ──────────────────────────────────────────────────────────

function formatChangeSet(result: ChangeSet, opts: PrettyFormatOptions): string {
  if (opts.quiet) {
    const semverMatch = result.claimedSemver != null &&
      SEVERITY_ORDER[result.claimedSemver] >= SEVERITY_ORDER[result.actualSemver]
    const verdict = result.claimedSemver
      ? (semverMatch ? c.green('VERIFIED') : c.red('MISMATCH'))
      : ''
    const claimed = result.claimedSemver ?? '?'
    return `${c.cyan('typediff')}  ${result.packageName} ${c.dim(result.oldVersion)} \u2192 ${result.newVersion}  ${claimed} \u2192 ${result.actualSemver}  ${verdict}`
  }

  const lines: string[] = []
  const verbose = opts.verbose ?? false

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push(
    `${INDENT}${c.bold(c.cyan('typediff'))}  ${result.packageName} ${c.dim(result.oldVersion)} \u2192 ${c.bold(result.newVersion)}`,
  )
  lines.push('')

  // Claimed / Actual
  const semverMatch =
    result.claimedSemver != null
    && SEVERITY_ORDER[result.claimedSemver] >= SEVERITY_ORDER[result.actualSemver]

  if (result.claimedSemver) {
    lines.push(`${INDENT}${c.dim('Claimed')}   ${result.claimedSemver}`)
    if (semverMatch) {
      lines.push(`${INDENT}${c.dim('Actual')}    ${result.actualSemver} ${c.green('\u2714 VERIFIED')}`)
    } else {
      lines.push(`${INDENT}${c.dim('Actual')}    ${c.red(c.bold(result.actualSemver))} ${c.red('\u2716 MISMATCH')}`)
    }
  } else {
    lines.push(`${INDENT}${c.dim('Actual')}    ${result.actualSemver}`)
  }

  // ── Empty state ─────────────────────────────────────────────────────────
  if (result.changes.length === 0) {
    lines.push('')
    lines.push(
      `${INDENT}No type changes detected between ${result.packageName} ${result.oldVersion} and ${result.newVersion} ${c.green('\u2714')}`,
    )
    if (verbose && result.timings) {
      appendTimings(lines, result.timings)
    }
    return lines.join('\n')
  }

  // ── Group changes ───────────────────────────────────────────────────────
  const breaking = result.changes.filter((ch) => ch.semver === 'major')
  const minor = result.changes.filter((ch) => ch.semver === 'minor')
  const compatible = result.changes.filter((ch) => ch.semver === 'patch')

  // ── Summary bar ─────────────────────────────────────────────────────────
  lines.push('')
  const parts: string[] = []
  if (breaking.length > 0) parts.push(c.red(`${breaking.length} breaking`))
  if (minor.length > 0) parts.push(c.yellow(`${minor.length} minor`))
  if (compatible.length > 0) parts.push(c.dim(`${compatible.length} compatible`))
  lines.push(`${INDENT}${parts.join(c.dim('  \u00b7  '))}`)

  // ── Breaking section ───────────────────────────────────────────────────
  if (breaking.length > 0) {
    lines.push('')
    lines.push(`${INDENT}${c.bgRed(c.bold(' BREAKING '))}`)
    lines.push('')
    const displayBreaking = verbose ? breaking : breaking.slice(0, 8)
    for (let i = 0; i < displayBreaking.length; i++) {
      lines.push(...formatBreakingChange(displayBreaking[i]))
      if (i < displayBreaking.length - 1) lines.push('')
    }
    if (!verbose && breaking.length > 8) {
      lines.push('')
      lines.push(`${INDENT}${c.dim(`... and ${breaking.length - 8} more breaking changes`)}`)
    }
  }

  // ── Minor section ─────────────────────────────────────────────────────
  if (minor.length > 0) {
    lines.push('')
    lines.push(`${INDENT}${c.bgYellow(c.bold(' MINOR '))}`)
    lines.push('')
    const displayMinor = verbose ? minor : minor.slice(0, MAX_DISPLAY)
    for (const ch of displayMinor) {
      lines.push(formatMinorChange(ch))
    }
    if (!verbose && minor.length > MAX_DISPLAY) {
      lines.push(`${INDENT}${c.dim(`... and ${minor.length - MAX_DISPLAY} more minor changes`)}`)
    }
  }

  // ── Compatible section ────────────────────────────────────────────────
  if (compatible.length > 0) {
    lines.push('')
    if (verbose) {
      lines.push(`${INDENT}${c.bgGreen(c.bold(' COMPATIBLE '))}`)
      lines.push('')
      for (const ch of compatible) {
        lines.push(formatPatchChange(ch))
      }
    } else {
      lines.push(
        `${INDENT}${c.green(`COMPATIBLE`)} ${c.dim(`(${compatible.length} changes verified as non-breaking)`)}`,
      )
    }
  }

  // ── Diagnostics ──────────────────────────────────────────────────────
  if (result.diagnostics && result.diagnostics.length > 0) {
    lines.push('')
    for (const diag of result.diagnostics) {
      lines.push(`${INDENT}${c.yellow('\u26A0')} ${c.dim(diag)}`)
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────
  if (result.claimedSemver && !semverMatch && result.actualSemver === 'major') {
    lines.push('')
    const nextMajor = incrementMajor(result.newVersion)
    if (nextMajor) {
      lines.push(`${INDENT}${c.dim(`This release contains breaking changes. Consider publishing as ${c.bold(nextMajor)} instead.`)}`)
    } else {
      lines.push(`${INDENT}${c.dim('This release contains breaking changes and should be a major version bump.')}`)
    }
  }

  // ── Timings (verbose only) ───────────────────────────────────────────
  if (verbose && result.timings) {
    appendTimings(lines, result.timings)
  }

  return lines.join('\n')
}

function incrementMajor(version: string): string | null {
  const match = version.match(/^(\d+)\./)
  if (!match) return null
  const major = parseInt(match[1], 10)
  // For 0.x, suggest 1.0.0
  if (major === 0) return '1.0.0'
  return `${major + 1}.0.0`
}

function appendTimings(lines: string[], timings: NonNullable<ChangeSet['timings']>): void {
  const parts: string[] = []
  if (timings.resolveMs != null) parts.push(`resolve ${timings.resolveMs}ms`)
  if (timings.extractMs != null) parts.push(`extract ${timings.extractMs}ms`)
  if (timings.diffMs != null) parts.push(`diff+compat ${timings.diffMs}ms`)
  if (timings.totalMs != null) parts.push(`total ${timings.totalMs}ms`)
  if (parts.length > 0) {
    lines.push('')
    lines.push(`${INDENT}${c.dim('Timings   ' + parts.join('  \u00b7  '))}`)
  }
}

export function formatPretty(results: ChangeSet[], opts?: PrettyFormatOptions): string {
  const options = opts ?? {}
  const body = results.map((r) => formatChangeSet(r, options)).join('\n\n')
  if (options.quiet) {
    return body
  }
  if (options.elapsedMs != null) {
    const seconds = (options.elapsedMs / 1000).toFixed(1)
    return `${body}\n\n${INDENT}${c.dim(`Done in ${seconds}s`)}`
  }
  return body
}
