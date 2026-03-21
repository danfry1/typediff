import { SEVERITY_ORDER, type ChangeSet, type TypediffOutput } from '../../core/types.js'

export function formatJson(results: ChangeSet[], opts?: { quiet?: boolean }): string {
  if (opts?.quiet) {
    const output = {
      schemaVersion: 1,
      results: results.map(r => ({
        packageName: r.packageName,
        oldVersion: r.oldVersion,
        newVersion: r.newVersion,
        actualSemver: r.actualSemver,
        claimedSemver: r.claimedSemver,
        verified: r.claimedSemver != null &&
          SEVERITY_ORDER[r.claimedSemver] >= SEVERITY_ORDER[r.actualSemver],
      })),
    }
    return JSON.stringify(output, null, 2)
  }
  const output: TypediffOutput = { schemaVersion: 1, results }
  return JSON.stringify(output, null, 2)
}
