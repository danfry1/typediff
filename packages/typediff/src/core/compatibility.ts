import ts from 'typescript'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createResolvedHost } from './extractor.js'

export interface CompatibilityResult {
  /** New type is assignable where old type was expected */
  newAssignableToOld: boolean
  /** Old type is assignable where new type is expected */
  oldAssignableToNew: boolean
}

interface ExportInfo {
  type: ts.Type
  symbol: ts.Symbol
  checker: ts.TypeChecker
}

/**
 * Check type compatibility between old and new versions of exports.
 *
 * Uses a two-phase approach for performance:
 * 1. Serialize all types to strings (~0.4s for 248 zod exports)
 * 2. Compare serialized strings — identical strings mean structurally
 *    equivalent types, so skip the expensive compilation step for those
 * 3. Only compile a synthetic check file for the few types that actually
 *    differ, keeping the compilation tiny and fast
 *
 * The old approach serialized ALL types into one huge file (~850KB for zod)
 * and compiled it all, taking 34+ seconds. This approach compiles only the
 * small subset that changed.
 */
export function checkCompatibility(
  oldDtsPath: string,
  newDtsPath: string,
  exportNames: string[],
): Map<string, CompatibilityResult> {
  if (exportNames.length === 0) return new Map()

  // Phase 1: Extract type information from both versions
  const oldExports = getExportInfo(oldDtsPath, exportNames)
  const newExports = getExportInfo(newDtsPath, exportNames)

  // Initialize results — default to compatible
  const results = new Map<string, CompatibilityResult>()
  for (const name of exportNames) {
    results.set(name, { newAssignableToOld: true, oldAssignableToNew: true })
  }

  // Phase 2: Serialize and compare strings
  // Identical serialized types are structurally equivalent — skip compilation
  const needsCheck: { name: string; oldStr: string; newStr: string }[] = []

  for (const name of exportNames) {
    const oldInfo = oldExports.get(name)
    const newInfo = newExports.get(name)
    if (!oldInfo || !newInfo) {
      // Cannot resolve this export — assume incompatible to avoid false downgrades
      results.set(name, { newAssignableToOld: false, oldAssignableToNew: false })
      continue
    }

    const oldStr = serializeType(oldInfo)
    const newStr = serializeType(newInfo)

    if (oldStr !== newStr) {
      needsCheck.push({ name, oldStr, newStr })
    }
    // If strings match, the default { true, true } is correct
  }

  if (needsCheck.length === 0) return results

  // Phase 3: Compile only the changed types
  const dir = join(tmpdir(), `typediff-compat-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })

  try {
    const checkLines: string[] = []
    checkLines.push(
      `type AssertAssignable<T, U> = [T] extends [U] ? true : never;`,
    )
    checkLines.push('')

    // Build a map from line number to { exportName, direction }
    // so diagnostic matching is O(1) per diagnostic instead of O(n)
    const lineMap = new Map<
      number,
      { name: string; direction: 'n2o' | 'o2n' }
    >()
    let hasSerializedNames = false

    for (const { name, oldStr, newStr } of needsCheck) {
      const sanitized = sanitize(name)

      checkLines.push(`type __Old_${sanitized} = ${oldStr};`)
      checkLines.push(`type __New_${sanitized} = ${newStr};`)
      checkLines.push('')

      checkLines.push(`// CHECK_NEW_TO_OLD_${name}`)
      const n2oConstLine = checkLines.length
      checkLines.push(
        `const __verify_n2o_${sanitized}: AssertAssignable<__New_${sanitized}, __Old_${sanitized}> = true;`,
      )
      lineMap.set(n2oConstLine, { name, direction: 'n2o' })

      checkLines.push(`// CHECK_OLD_TO_NEW_${name}`)
      const o2nConstLine = checkLines.length
      checkLines.push(
        `const __verify_o2n_${sanitized}: AssertAssignable<__Old_${sanitized}, __New_${sanitized}> = true;`,
      )
      lineMap.set(o2nConstLine, { name, direction: 'o2n' })

      checkLines.push('')
      hasSerializedNames = true
    }

    if (!hasSerializedNames) return results

    const checkFilePath = join(dir, 'check.ts')
    writeFileSync(checkFilePath, checkLines.join('\n'))

    const program = ts.createProgram([checkFilePath], {
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    })

    const diagnostics = ts.getPreEmitDiagnostics(program)

    for (const diag of diagnostics) {
      if (diag.file?.fileName !== checkFilePath) continue
      if (diag.start === undefined) continue

      const lineNum = diag.file.getLineAndCharacterOfPosition(diag.start).line
      const entry = lineMap.get(lineNum)
      if (!entry) continue

      if (entry.direction === 'n2o') {
        results.get(entry.name)!.newAssignableToOld = false
      } else {
        results.get(entry.name)!.oldAssignableToNew = false
      }
    }

    return results
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Extract type information for a set of export names from a .d.ts file.
 */
function getExportInfo(
  dtsPath: string,
  exportNames: string[],
): Map<string, ExportInfo> {
  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  }
  const program = ts.createProgram([dtsPath], compilerOptions, createResolvedHost(compilerOptions))

  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(dtsPath)
  const result = new Map<string, ExportInfo>()

  if (!sourceFile) return result

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) return result

  const moduleExports = checker.getExportsOfModule(moduleSymbol)
  const exportMap = new Map<string, ts.Symbol>()
  for (const sym of moduleExports) {
    exportMap.set(sym.getName(), sym)
  }

  // Handle export = — getExportsOfModule returns nothing for this pattern.
  // The extractor normalizes it to a 'default' export, so look it up the same way.
  if (moduleExports.length === 0) {
    const exportEqualsSym = (moduleSymbol.exports as ReadonlyMap<ts.__String, ts.Symbol> | undefined)
      ?.get('export=' as unknown as ts.__String)
    if (exportEqualsSym) {
      exportMap.set('default', exportEqualsSym)
    }
  }

  for (const name of exportNames) {
    const sym = exportMap.get(name)
    if (!sym) continue

    const decls = sym.getDeclarations()
    if (!decls || decls.length === 0) continue

    // Resolve through aliases (re-exports) to get the true symbol
    const resolved = (sym.flags & ts.SymbolFlags.Alias)
      ? checker.getAliasedSymbol(sym)
      : sym

    const flags = resolved.flags
    const isTypeOnly =
      ((flags & ts.SymbolFlags.Interface) !== 0 ||
        (flags & ts.SymbolFlags.TypeAlias) !== 0) &&
      (flags & ts.SymbolFlags.Variable) === 0 &&
      (flags & ts.SymbolFlags.Function) === 0 &&
      (flags & ts.SymbolFlags.Class) === 0

    const resolvedDecls = resolved.getDeclarations()
    const effectiveDecl = resolvedDecls?.[0] ?? decls[0]

    const type = isTypeOnly
      ? checker.getDeclaredTypeOfSymbol(resolved)
      : checker.getTypeOfSymbolAtLocation(resolved, effectiveDecl)

    result.set(name, { type, symbol: resolved, checker })
  }

  return result
}

/**
 * Serialize a type to a string representation suitable for embedding
 * in a synthetic TypeScript file. For named types like interfaces,
 * this expands them to their structural form to avoid name collisions.
 */
function serializeType(info: ExportInfo): string {
  const { type, symbol, checker } = info
  const flags = symbol.flags

  if ((flags & ts.SymbolFlags.Interface) !== 0) {
    return serializeObjectType(type, checker)
  }

  if ((flags & ts.SymbolFlags.Class) !== 0) {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol)
    return serializeObjectType(declaredType, checker)
  }

  if ((flags & ts.SymbolFlags.TypeAlias) !== 0) {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol)
    return serializeExpandedType(declaredType, checker, new Set())
  }

  if ((flags & ts.SymbolFlags.Function) !== 0) {
    return serializeFunctionType(type, checker)
  }

  return checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  )
}

function serializeExpandedType(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
): string {
  if (seen.has(type)) {
    return checker.typeToString(
      type,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
  }
  seen.add(type)

  if (type.isUnion()) {
    const members = type.types.map((t) =>
      serializeExpandedType(t, checker, new Set(seen)),
    )
    return members.join(' | ')
  }

  if (type.isIntersection()) {
    const members = type.types.map((t) =>
      serializeExpandedType(t, checker, new Set(seen)),
    )
    return members.map((m) => (m.includes('|') ? `(${m})` : m)).join(' & ')
  }

  const properties = type.getProperties()
  const callSignatures = type.getCallSignatures()
  const constructSignatures = type.getConstructSignatures()

  if (
    properties.length > 0 ||
    callSignatures.length > 0 ||
    constructSignatures.length > 0
  ) {
    const sym = type.getSymbol()
    if (sym) {
      const symFlags = sym.flags
      if (
        (symFlags & ts.SymbolFlags.Interface) !== 0 ||
        (symFlags & ts.SymbolFlags.Class) !== 0
      ) {
        return serializeObjectType(type, checker)
      }
    }

    if (callSignatures.length > 0 && properties.length === 0) {
      return serializeFunctionTypeFromSignatures(callSignatures, checker)
    }
  }

  return checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  )
}

function serializeObjectType(type: ts.Type, checker: ts.TypeChecker): string {
  const properties = type.getProperties()
  const callSignatures = type.getCallSignatures()
  const constructSignatures = type.getConstructSignatures()

  const parts: string[] = []

  for (const sig of callSignatures) {
    parts.push(serializeCallSignature(sig, checker))
  }

  for (const sig of constructSignatures) {
    parts.push(`new ${serializeCallSignature(sig, checker)}`)
  }

  // Include index signatures (e.g., [key: string]: unknown)
  const indexInfos = checker.getIndexInfosOfType(type)
  for (const info of indexInfos) {
    const keyStr = checker.typeToString(info.keyType, undefined, ts.TypeFormatFlags.NoTruncation)
    const valStr = checker.typeToString(info.type, undefined, ts.TypeFormatFlags.NoTruncation)
    const ro = info.isReadonly ? 'readonly ' : ''
    parts.push(`${ro}[key: ${keyStr}]: ${valStr}`)
  }

  for (const prop of properties) {
    const decls = prop.getDeclarations()
    if (!decls || decls.length === 0) continue

    const propType = checker.getTypeOfSymbolAtLocation(prop, decls[0])
    const propTypeStr = checker.typeToString(
      propType,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0
    const isReadonly = decls.some((d) => {
      if (ts.canHaveModifiers(d) && d.modifiers) {
        return d.modifiers.some(
          (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
        )
      }
      // PropertySignature may not pass canHaveModifiers in all TS versions
      if (ts.isPropertySignature(d) && d.modifiers) {
        return d.modifiers.some(
          (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
        )
      }
      return false
    })

    const prefix = isReadonly ? 'readonly ' : ''
    const optMark = isOptional ? '?' : ''
    const rawName = prop.getName()
    const propName = needsQuoting(rawName) ? `"${rawName}"` : rawName
    parts.push(`${prefix}${propName}${optMark}: ${propTypeStr}`)
  }

  return `{ ${parts.join('; ')} }`
}

function serializeFunctionType(
  type: ts.Type,
  checker: ts.TypeChecker,
): string {
  const signatures = type.getCallSignatures()
  if (signatures.length === 0) {
    return checker.typeToString(
      type,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
  }

  return serializeFunctionTypeFromSignatures(signatures, checker)
}

function serializeFunctionTypeFromSignatures(
  signatures: readonly ts.Signature[],
  checker: ts.TypeChecker,
): string {
  if (signatures.length === 1) {
    return serializeCallSignatureAsArrow(signatures[0], checker)
  }

  const parts = signatures.map((sig) => serializeCallSignature(sig, checker))
  return `{ ${parts.join('; ')} }`
}

function serializeCallSignature(
  sig: ts.Signature,
  checker: ts.TypeChecker,
): string {
  const params = sig.parameters.map((p) => {
    const decls = p.getDeclarations()
    if (!decls || decls.length === 0) return `${p.getName()}: any`
    const paramType = checker.getTypeOfSymbolAtLocation(p, decls[0])
    const paramTypeStr = checker.typeToString(
      paramType,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
    const isOptional = (p.flags & ts.SymbolFlags.Optional) !== 0
    return `${p.getName()}${isOptional ? '?' : ''}: ${paramTypeStr}`
  })

  const returnType = sig.getReturnType()
  const returnTypeStr = checker.typeToString(
    returnType,
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  )

  return `(${params.join(', ')}): ${returnTypeStr}`
}

function serializeCallSignatureAsArrow(
  sig: ts.Signature,
  checker: ts.TypeChecker,
): string {
  const params = sig.parameters.map((p) => {
    const decls = p.getDeclarations()
    if (!decls || decls.length === 0) return `${p.getName()}: any`
    const paramType = checker.getTypeOfSymbolAtLocation(p, decls[0])
    const paramTypeStr = checker.typeToString(
      paramType,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
    const isOptional = (p.flags & ts.SymbolFlags.Optional) !== 0
    return `${p.getName()}${isOptional ? '?' : ''}: ${paramTypeStr}`
  })

  const returnType = sig.getReturnType()
  const returnTypeStr = checker.typeToString(
    returnType,
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  )

  return `(${params.join(', ')}) => ${returnTypeStr}`
}

function needsQuoting(name: string): boolean {
  return !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
}

function sanitize(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9_]/g, '_')
  if (base !== name) {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
    }
    const RADIX = 36
    return `${base}_${(hash >>> 0).toString(RADIX)}`
  }
  return base
}
