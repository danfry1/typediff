import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ApiNode, ApiTree } from './types.js'
import { resolveMultiEntry } from '../resolver/local.js'
import { extractApiTree } from './extractor.js'
import { getVersion } from './version.js'

export interface ApiSnapshot {
  snapshotVersion: 1
  typediffVersion: string
  packageName: string
  packageVersion: string
  createdAt: string
  entryPoints: Record<string, ApiTree>
}

export function createSnapshot(localPath: string, onWarn?: (msg: string) => void): ApiSnapshot {
  const multi = resolveMultiEntry(localPath)
  const entryPoints: Record<string, ApiTree> = {}

  for (const entry of multi.entries) {
    entryPoints[entry.entryPoint] = extractApiTree(entry.typesPath, {
      packageName: multi.packageName,
      version: multi.version,
      entryPoint: entry.entryPoint,
      onWarn,
    })
  }

  return {
    snapshotVersion: 1,
    typediffVersion: getVersion(),
    packageName: multi.packageName,
    packageVersion: multi.version,
    createdAt: new Date().toISOString(),
    entryPoints,
  }
}

export function loadSnapshot(
  filePath: string,
  onWarn?: (msg: string) => void,
): ApiSnapshot {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    throw new Error(
      `Snapshot file not found: "${filePath}". Run \`typediff snapshot <path> -o ${filePath}\` to create it.`
    )
  }

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `Failed to parse snapshot file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  if (obj.snapshotVersion !== 1) {
    throw new Error(`Unsupported snapshot version: ${obj.snapshotVersion}. Expected 1.`)
  }
  if (!obj.entryPoints || typeof obj.entryPoints !== 'object' || Array.isArray(obj.entryPoints)) {
    throw new Error(
      `Invalid snapshot file "${filePath}": missing or malformed entryPoints field.`,
    )
  }
  if (typeof obj.packageName !== 'string' || typeof obj.packageVersion !== 'string') {
    throw new Error(
      `Invalid snapshot file "${filePath}": missing packageName or packageVersion.`,
    )
  }
  const entryKeys = Object.keys(obj.entryPoints as Record<string, unknown>)
  if (entryKeys.length === 0) {
    throw new Error(
      `Invalid snapshot file "${filePath}": entryPoints must contain at least one entry point.`,
    )
  }
  // Validate each entry point has a valid ApiTree structure
  for (const [key, tree] of Object.entries(obj.entryPoints as Record<string, unknown>)) {
    if (tree == null || typeof tree !== 'object' || !Array.isArray((tree as Record<string, unknown>).exports)) {
      throw new Error(
        `Invalid snapshot file "${filePath}": entry point "${key}" is missing or has a malformed exports array.`,
      )
    }
    const exports = (tree as Record<string, unknown>).exports as unknown[]
    for (let i = 0; i < exports.length; i++) {
      const node = exports[i] as Record<string, unknown> | null | undefined
      if (
        node == null ||
        typeof node !== 'object' ||
        typeof node.name !== 'string' ||
        typeof node.kind !== 'string' ||
        typeof node.signature !== 'string' ||
        !Array.isArray(node.children) ||
        node.modifiers == null ||
        typeof node.modifiers !== 'object'
      ) {
        throw new Error(
          `Invalid snapshot file "${filePath}": entry point "${key}" contains a malformed export node at index ${i}.`,
        )
      }
    }
  }
  const snapshot = obj as unknown as ApiSnapshot
  const currentVersion = getVersion()
  if (snapshot.typediffVersion && snapshot.typediffVersion !== currentVersion) {
    onWarn?.(
      `Snapshot created with typediff ${snapshot.typediffVersion}, ` +
      `current version is ${currentVersion}. Results may include false positives.`
    )
  }
  return snapshot
}

export function snapshotToApiTrees(snapshot: ApiSnapshot): Map<string, ApiTree> {
  return new Map(Object.entries(snapshot.entryPoints))
}

/**
 * Synthesize a temporary .d.ts file from an ApiTree's top-level export signatures.
 * This enables running the compatibility checker against snapshot data.
 *
 * Returns the path to the synthesized file and a cleanup function.
 * The caller MUST call cleanup() when done.
 */
export function synthesizeDtsFromTree(tree: ApiTree): { dtsPath: string; cleanup: () => void } {
  const dir = join(tmpdir(), `typediff-snapshot-synth-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })

  const lines: string[] = []
  for (const node of tree.exports) {
    lines.push(synthesizeExport(node))
  }

  const dtsPath = join(dir, 'index.d.ts')
  writeFileSync(dtsPath, lines.join('\n'))

  return {
    dtsPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function synthesizeExport(node: ApiNode): string {
  const typeParams = synthesizeTypeParams(node.children)

  if (node.name === 'default') {
    return synthesizeDefaultExport(node, typeParams)
  }

  switch (node.kind) {
    case 'interface':
      return `export interface ${node.name}${typeParams} { ${synthesizeMembers(node.children)} }`
    case 'type-alias':
      return `export type ${node.name}${typeParams} = ${node.signature};`
    case 'function':
      return `export declare function ${node.name}${typeParams}${synthesizeFunctionSig(node)};`
    case 'class':
      return `export declare class ${node.name}${typeParams} { ${synthesizeMembers(node.children)} }`
    case 'const':
      return `export declare const ${node.name}: ${node.signature};`
    case 'enum':
      return synthesizeEnum(node)
    case 'namespace':
      return `export declare namespace ${node.name} { ${node.children.map(synthesizeExport).join(' ')} }`
    default:
      return `export declare const ${node.name}: ${node.signature};`
  }
}

function synthesizeDefaultExport(node: ApiNode, typeParams: string): string {
  switch (node.kind) {
    case 'function':
      return `export default function${typeParams}${synthesizeFunctionSig(node)};`
    case 'class':
      return `export default class${typeParams} { ${synthesizeMembers(node.children)} }`
    case 'interface':
      return `interface _Default${typeParams} { ${synthesizeMembers(node.children)} }\nexport type { _Default as default };`
    case 'type-alias':
      return `type _Default${typeParams} = ${node.signature};\nexport type { _Default as default };`
    default:
      return `declare const _default: ${node.signature};\nexport default _default;`
  }
}

/** Synthesize generic type parameter declarations from children. */
function synthesizeTypeParams(children: ApiNode[]): string {
  const typeParams = children.filter((c) => c.kind === 'type-parameter')
  if (typeParams.length === 0) return ''

  const params = typeParams.map((tp) => {
    let param = tp.name
    // signature contains the constraint (e.g., "string" or "Record<string, unknown> = {}")
    // Use indexOf to split on first ' = ' only, preserving defaults that contain ' = '
    const eqIdx = tp.signature.indexOf(' = ')
    const constraint = eqIdx === -1 ? tp.signature : tp.signature.slice(0, eqIdx)
    const defaultType = eqIdx === -1 ? undefined : tp.signature.slice(eqIdx + 3)
    if (constraint && constraint !== 'unknown') {
      param += ` extends ${constraint}`
    }
    if (defaultType) {
      param += ` = ${defaultType}`
    }
    return param
  })

  return `<${params.join(', ')}>`
}

function synthesizeFunctionSig(node: ApiNode): string {
  const params = node.children
    .filter((c) => c.kind === 'parameter')
    .map((c) => {
      const rest = c.modifiers.isRest ? '...' : ''
      const opt = c.modifiers.optional ? '?' : ''
      return `${rest}${c.name}${opt}: ${c.signature}`
    })
  const ret = node.children.find((c) => c.kind === 'return-type')
  return `(${params.join(', ')}): ${ret?.signature ?? 'void'}`
}

function synthesizeEnum(node: ApiNode): string {
  if (node.children.length === 0) {
    return `export declare enum ${node.name} {}`
  }
  const members = node.children.map((c) => {
    // If the signature is a string/number literal, use it as the initializer
    if (c.signature.startsWith('"') || c.signature.startsWith("'") || /^-?\d+$/.test(c.signature) || /^0x[\da-fA-F]+$/i.test(c.signature)) {
      return `${c.name} = ${c.signature}`
    }
    return c.name
  })
  return `export declare enum ${node.name} { ${members.join(', ')} }`
}

/** Replace the last ` => ` with `: ` to convert arrow return type to colon return type. */
function replaceLastArrow(sig: string): string {
  const idx = sig.lastIndexOf(' => ')
  if (idx === -1) return sig.replace(' => ', ': ')
  return sig.slice(0, idx) + ': ' + sig.slice(idx + 4)
}

function synthesizeMembers(children: ApiNode[]): string {
  return children
    .filter((c) => c.kind !== 'type-parameter')
    .map((c) => {
      const ro = c.modifiers.readonly ? 'readonly ' : ''
      const opt = c.modifiers.optional ? '?' : ''

      // Index signatures (e.g., [index:string])
      if (c.kind === 'property' && c.name.startsWith('[index:')) {
        return `${c.signature};`
      }
      // Call signatures — replace the LAST ' => ' (the return-type arrow),
      // not the first, to avoid corrupting arrows inside callback parameters.
      if (c.kind === 'method' && c.name.startsWith('[call')) {
        return `${replaceLastArrow(c.signature)};`
      }
      // Construct signatures — signature already starts with "new"
      if (c.kind === 'method' && c.name.startsWith('[new')) {
        return `${replaceLastArrow(c.signature)};`
      }
      const abs = c.modifiers.abstract ? 'abstract ' : ''
      const vis = c.modifiers.visibility === 'protected' ? 'protected ' : ''
      if (c.kind === 'method') {
        return `${vis}${abs}${c.name}${synthesizeTypeParams(c.children)}${synthesizeFunctionSig(c)};`
      }
      return `${vis}${abs}${ro}${c.name}${opt}: ${c.signature};`
    })
    .join(' ')
}
