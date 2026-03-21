import { SEVERITY_ORDER, type ChangeSet } from 'typediff'

const MARKER = '<!-- typediff-verify -->'

export function getCommentMarker(): string {
  return MARKER
}

function isMismatch(result: ChangeSet): boolean {
  if (result.claimedSemver == null) return false
  return SEVERITY_ORDER[result.actualSemver] > SEVERITY_ORDER[result.claimedSemver]
}

function statusEmoji(result: ChangeSet): string {
  if (result.claimedSemver == null) return ':grey_question: Unknown'
  return isMismatch(result) ? ':x: Mismatch' : ':white_check_mark: Verified'
}

export function formatComment(results: ChangeSet[]): string {
  const lines: string[] = []

  lines.push(MARKER)
  lines.push('')
  lines.push('## Dependency Type Verification')
  lines.push('')
  lines.push('| Package | Claimed | Actual | Status |')
  lines.push('| ------- | ------- | ------ | ------ |')

  for (const result of results) {
    const claimed = result.claimedSemver ?? 'unknown'
    const status = statusEmoji(result)
    lines.push(
      `| \`${result.packageName}\` (${result.oldVersion} → ${result.newVersion}) | ${claimed} | ${result.actualSemver} | ${status} |`,
    )
  }

  // Add details blocks for mismatched packages
  const mismatched = results.filter(isMismatch)
  if (mismatched.length > 0) {
    lines.push('')
    lines.push('### Mismatched Packages')

    for (const result of mismatched) {
      lines.push('')
      lines.push(
        `<details><summary><strong>${result.packageName}</strong> — claimed ${result.claimedSemver}, actual ${result.actualSemver}</summary>`,
      )
      lines.push('')

      if (result.changes.length === 0) {
        lines.push('No detailed changes available.')
      } else {
        lines.push('| Change | Path | Severity | Description |')
        lines.push('| ------ | ---- | -------- | ----------- |')
        for (const change of result.changes) {
          const escapedDesc = change.description.replace(/\|/g, '\\|')
          lines.push(
            `| ${change.kind} | \`${change.path}\` | ${change.semver} | ${escapedDesc} |`,
          )
        }
      }

      lines.push('')
      lines.push('</details>')
    }
  }

  lines.push('')

  let body = lines.join('\n')

  // GitHub has a 65536-byte comment body limit. If we exceed it, truncate
  // the details sections and add a note.
  const MAX_COMMENT_SIZE = 65000
  if (body.length > MAX_COMMENT_SIZE) {
    // Keep the summary table, drop the details sections
    const detailsIdx = body.indexOf('### Mismatched Packages')
    if (detailsIdx !== -1) {
      body = body.slice(0, detailsIdx) +
        `> **Note:** Full details truncated (${results.length} packages, ${body.length} characters). ` +
        `Run \`typediff inspect\` locally for complete output.\n`
    }
  }

  return body
}
