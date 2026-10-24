import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { diffLocal } from '../index.js'

const fixture = (name: string): string =>
  resolve(import.meta.dirname, 'fixtures', name)

describe('ChangeSet diagnostics', () => {
  it('surfaces a diagnostic when exports reference unresolved dependency types', async () => {
    const result = await diffLocal(
      fixture('degraded-any/old'),
      fixture('degraded-any/new'),
    )

    expect(result.diagnostics).toBeDefined()
    expect(result.diagnostics!.length).toBeGreaterThan(0)
    expect(result.diagnostics!.some((d) => d.includes('could not be resolved'))).toBe(true)
  })

  it('does not attach diagnostics for a clean, fully-resolvable diff', async () => {
    const result = await diffLocal(
      fixture('export-added/old'),
      fixture('export-added/new'),
    )

    // No degraded analysis → the field is omitted entirely.
    expect(result.diagnostics).toBeUndefined()
  })

  it('still forwards warnings to a user-supplied onWarn callback', async () => {
    const warnings: string[] = []
    const result = await diffLocal(
      fixture('degraded-any/old'),
      fixture('degraded-any/new'),
      { onWarn: (msg) => warnings.push(msg) },
    )

    expect(warnings.length).toBeGreaterThan(0)
    // Everything the user sees inline is also captured on the result.
    for (const diag of result.diagnostics ?? []) {
      expect(warnings).toContain(diag)
    }
  })
})
