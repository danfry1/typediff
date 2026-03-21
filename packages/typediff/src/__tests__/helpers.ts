import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function createTempDts(content: string): { filePath: string; cleanup: () => void } {
  const dir = join(tmpdir(), `typediff-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'index.d.ts')
  writeFileSync(filePath, content)
  return { filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
