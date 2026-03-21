import { SEVERITY_ORDER, type ChangeSet } from 'typediff'

export type FailOn = 'major' | 'minor' | 'never'

/**
 * Returns true if any result has actualSemver > claimedSemver
 * and actualSemver >= the failOn threshold.
 */
export function shouldFail(results: ChangeSet[], failOn: FailOn): boolean {
  if (failOn === 'never') return false

  const threshold = SEVERITY_ORDER[failOn]

  return results.some((result) => {
    // Skip results without a claimed semver
    if (result.claimedSemver == null) return false

    const actual = SEVERITY_ORDER[result.actualSemver]
    const claimed = SEVERITY_ORDER[result.claimedSemver]

    // actualSemver must exceed claimedSemver AND meet the threshold
    return actual > claimed && actual >= threshold
  })
}
