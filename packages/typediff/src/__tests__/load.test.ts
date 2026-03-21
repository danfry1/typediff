import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractApiTree } from '../core/extractor.js'
import { diffApiTrees } from '../core/differ.js'
import { classifyChange } from '../core/classifier.js'
import { checkCompatibility } from '../core/compatibility.js'

let tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'typediff-load-'))
  tempDirs.push(dir)
  return dir
}

function generateLargeDts(exportCount: number): string {
  const lines: string[] = []
  const interfaceCount = Math.floor(exportCount * 0.6)
  const functionCount = Math.floor(exportCount * 0.3)
  const typeCount = exportCount - interfaceCount - functionCount

  for (let i = 0; i < interfaceCount; i++) {
    lines.push(`export interface Type${i} {`)
    for (let j = 0; j < 5; j++) {
      lines.push(`  prop${j}: string;`)
    }
    lines.push('}')
  }

  for (let i = 0; i < functionCount; i++) {
    lines.push(`export declare function fn${i}(a: string, b: number): Type${i % interfaceCount};`)
  }

  for (let i = 0; i < typeCount; i++) {
    const members = Array.from({ length: 5 }, (_, j) => `"val${i * 5 + j}"`).join(' | ')
    lines.push(`export type Union${i} = ${members};`)
  }

  return lines.join('\n')
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('load tests', () => {
  it('extracts 1000 exports within 5 seconds', () => {
    const dir = makeTempDir()
    const dts = generateLargeDts(1000)
    writeFileSync(join(dir, 'index.d.ts'), dts)

    const t0 = performance.now()
    const tree = extractApiTree(join(dir, 'index.d.ts'), {
      packageName: 'load-test',
      version: '1.0.0',
      entryPoint: '.',
    })
    const elapsed = performance.now() - t0

    expect(tree.exports.length).toBe(1000)
    expect(elapsed).toBeLessThan(5000)
  })

  it('diffs two large packages (1000 exports, 10 changes) within 10 seconds', () => {
    const dir = makeTempDir()
    const dts1 = generateLargeDts(1000)

    // Modify types in the first 5 interfaces and add 5 new exports
    let dts2 = dts1
    for (let i = 0; i < 5; i++) {
      // Replace prop0 in a specific interface by targeting the unique interface name
      dts2 = dts2.replace(
        `export interface Type${i} {\n  prop0: string;`,
        `export interface Type${i} {\n  prop0: number;`,
      )
    }
    for (let i = 0; i < 5; i++) {
      dts2 += `\nexport declare function added${i}(): void;`
    }

    writeFileSync(join(dir, 'old.d.ts'), dts1)
    writeFileSync(join(dir, 'new.d.ts'), dts2)

    const t0 = performance.now()

    const oldTree = extractApiTree(join(dir, 'old.d.ts'), {
      packageName: 'load-test',
      version: '1.0.0',
      entryPoint: '.',
    })
    const newTree = extractApiTree(join(dir, 'new.d.ts'), {
      packageName: 'load-test',
      version: '2.0.0',
      entryPoint: '.',
    })

    const changes = diffApiTrees(oldTree, newTree)
    for (const c of changes) {
      c.semver = classifyChange(c, c.oldNode, c.newNode)
    }

    const elapsed = performance.now() - t0

    expect(changes.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(10000)
  })

  it('compatibility check on 100 changed exports completes within 15 seconds', () => {
    const dir = makeTempDir()

    // Create 100 interfaces with different signatures between old and new
    const oldLines: string[] = []
    const newLines: string[] = []
    const exportNames: string[] = []

    for (let i = 0; i < 100; i++) {
      exportNames.push(`Changed${i}`)
      oldLines.push(`export interface Changed${i} { value: string; count: number; }`)
      newLines.push(`export interface Changed${i} { value: string; count: number; extra${i}: boolean; }`)
    }
    // Add 200 unchanged interfaces as noise
    for (let i = 0; i < 200; i++) {
      const line = `export interface Stable${i} { x: string; }`
      oldLines.push(line)
      newLines.push(line)
    }

    writeFileSync(join(dir, 'old.d.ts'), oldLines.join('\n'))
    writeFileSync(join(dir, 'new.d.ts'), newLines.join('\n'))

    const t0 = performance.now()
    const results = checkCompatibility(
      join(dir, 'old.d.ts'),
      join(dir, 'new.d.ts'),
      exportNames,
    )
    const elapsed = performance.now() - t0

    expect(results.size).toBe(100)
    expect(elapsed).toBeLessThan(15000)

    // Adding a required property: new extends old (has all its fields + more),
    // but old does NOT extend new (missing the new required field)
    for (const [, result] of results) {
      expect(result.newAssignableToOld).toBe(true)
      expect(result.oldAssignableToNew).toBe(false)
    }
  })

  it('handles 5000 exports without crashing', () => {
    const dir = makeTempDir()
    const dts = generateLargeDts(5000)
    writeFileSync(join(dir, 'index.d.ts'), dts)

    const tree = extractApiTree(join(dir, 'index.d.ts'), {
      packageName: 'load-test',
      version: '1.0.0',
      entryPoint: '.',
    })

    expect(tree.exports.length).toBe(5000)
    // Memory check: heap should stay under 512MB for 5000 exports
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024
    expect(heapMB).toBeLessThan(512)
  })
})
