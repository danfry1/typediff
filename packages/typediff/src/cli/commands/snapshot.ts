import { writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSnapshot } from '../../core/snapshot.js'

export async function runSnapshot(args: string[], outputFile?: string): Promise<void> {
  if (args.length < 1) {
    console.error('Error: snapshot requires a path argument. Usage: typediff snapshot <path> [-o <file>]')
    process.exit(2)
  }

  const targetPath = resolve(args[0])
  if (!existsSync(targetPath)) {
    console.error(`Error: Path not found: "${args[0]}"`)
    process.exit(2)
  }

  const snapshot = createSnapshot(targetPath, (msg) => console.error(`  Warning: ${msg}`))
  const json = JSON.stringify(snapshot, null, 2)

  if (outputFile) {
    writeFileSync(outputFile, json)
    console.error(`Snapshot written to ${outputFile}`)
  } else {
    console.log(json)
  }
}
