import * as core from '@actions/core'
import * as github from '@actions/github'
import { minimatch } from 'minimatch'
import { diff, type ChangeSet, type SemverLevel } from 'typediff'
import { parseLockfileDiff, detectLockfileType } from './lockfile.js'
import { formatComment, getCommentMarker } from './comment.js'
import { shouldFail, type FailOn } from './check.js'

async function run(): Promise<void> {
  try {
    // 1. Read inputs
    const token = core.getInput('github-token', { required: true })
    const severityInput = core.getInput('severity') || 'minor'
    if (!['major', 'minor', 'patch'].includes(severityInput)) {
      core.setFailed(`Invalid severity "${severityInput}". Must be major, minor, or patch.`)
      return
    }
    const severity = severityInput as SemverLevel

    const failOnInput = core.getInput('fail-on') || 'major'
    if (!['major', 'minor', 'never'].includes(failOnInput)) {
      core.setFailed(`Invalid fail-on "${failOnInput}". Must be major, minor, or never.`)
      return
    }
    const failOn = failOnInput as FailOn
    const ignoreRaw = core.getInput('ignore')
    const ignore = ignoreRaw
      ? ignoreRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : []

    const octokit = github.getOctokit(token)
    const { context } = github

    // 2. Get PR number from context
    const prNumber = context.payload.pull_request?.number
    if (!prNumber) {
      core.info('Not a pull request event — skipping.')
      return
    }

    const owner = context.repo.owner
    const repo = context.repo.repo

    // 3. List PR files, find lockfile
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    })

    const lockfiles = files.filter((f) => detectLockfileType(f.filename) !== null)
    if (lockfiles.length === 0) {
      core.info('No lockfile changes detected — skipping.')
      return
    }

    for (const lf of lockfiles) {
      core.info(`Detected lockfile: ${lf.filename} (${detectLockfileType(lf.filename)})`)
    }

    // 4. Parse lockfile diffs (may have multiple lockfiles)
    const changedPackages: { name: string; oldVersion: string; newVersion: string }[] = []
    const seen = new Set<string>()
    for (const lf of lockfiles) {
      const lfType = detectLockfileType(lf.filename)!
      const patch = lf.patch ?? ''
      if (!lf.patch) {
        core.warning(
          `${lf.filename} diff was truncated by GitHub (file too large). ` +
          `Some dependency changes may not be analyzed.`,
        )
      }
      for (const pkg of parseLockfileDiff(patch, lfType)) {
        const key = `${pkg.name}@${pkg.oldVersion}->${pkg.newVersion}`
        if (!seen.has(key)) {
          seen.add(key)
          changedPackages.push(pkg)
        }
      }
    }

    if (changedPackages.length === 0) {
      core.info('No dependency version changes detected — skipping.')
      return
    }

    // Filter out ignored packages
    const filteredPackages = changedPackages.filter(
      (pkg) => !ignore.some((pattern) => minimatch(pkg.name, pattern)),
    )

    if (filteredPackages.length === 0) {
      core.info('All changed packages are ignored — skipping.')
      return
    }

    // Cap the number of packages to avoid excessively long runs on mass-update PRs
    const MAX_PACKAGES = 50
    if (filteredPackages.length > MAX_PACKAGES) {
      core.warning(
        `${filteredPackages.length} packages changed — analyzing only the first ${MAX_PACKAGES}. ` +
        `Run \`typediff inspect\` locally for complete results.`,
      )
      filteredPackages.length = MAX_PACKAGES
    }

    core.info(`Analyzing ${filteredPackages.length} changed package(s)...`)

    // 5. Run typediff diff() on each changed package (parallel, concurrency 5)
    const results: ChangeSet[] = []
    const batches = chunk(filteredPackages, 5)

    for (const batch of batches) {
      const settled = await Promise.allSettled(
        batch.map((pkg) =>
          diff(pkg.name, pkg.oldVersion, pkg.newVersion, { severity }),
        ),
      )

      for (let j = 0; j < settled.length; j++) {
        const result = settled[j]
        if (result.status === 'fulfilled') {
          results.push(result.value)
        } else {
          const pkg = batch[j]
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
          core.warning(`Failed to analyze ${pkg.name}@${pkg.oldVersion}→${pkg.newVersion}: ${reason}`)
        }
      }
    }

    if (results.length === 0) {
      core.warning('No packages could be analyzed — skipping comment.')
      core.setOutput('result', 'pass')
      core.setOutput('actual-semver', 'patch')
      return
    }

    core.info(`Analysis complete: ${results.length} package(s) analyzed.`)

    // 6. Format comment, post/update (find existing by marker)
    const body = formatComment(results)
    const marker = getCommentMarker()

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    })

    const existing = comments.find(
      (c) => c.body?.includes(marker),
    )

    try {
      if (existing) {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existing.id,
          body,
        })
        core.info(`Updated existing comment #${existing.id}`)
      } else {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        })
        core.info('Created new comment')
      }
    } catch (err: unknown) {
      const HTTP_FORBIDDEN = 403
      const status = (err as { status?: number }).status
      if (status === HTTP_FORBIDDEN) {
        core.warning(
          'Cannot post PR comment: token lacks write permission. ' +
          'This commonly happens on fork PRs. Add `pull-requests: write` to job permissions.',
        )
      } else {
        core.warning(`Could not post PR comment: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 7. Set outputs and check status via shouldFail()
    // Set outputs for downstream steps
    const highestSemver = results.reduce((highest, r) => {
      const order = { patch: 0, minor: 1, major: 2 } as const
      return order[r.actualSemver] > order[highest] ? r.actualSemver : highest
    }, 'patch' as 'patch' | 'minor' | 'major')
    core.setOutput('actual-semver', highestSemver)

    const fail = shouldFail(results, failOn)
    if (fail) {
      core.setOutput('result', 'fail')
      core.setFailed(
        'Dependency type changes exceed claimed semver. See PR comment for details.',
      )
    } else {
      core.setOutput('result', 'pass')
      core.info('All dependency type changes match claimed semver.')
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unexpected error occurred')
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

export { run, chunk }
