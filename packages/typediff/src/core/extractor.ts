import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import type { ApiNode, ApiTree, NodeKind, Position, Modifiers } from './types.js'

export interface ExtractOptions {
  packageName: string
  version: string
  entryPoint: string
  onWarn?: (message: string) => void
}

const TS_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Node16,
  moduleResolution: ts.ModuleResolutionKind.Node16,
  declaration: true,
  strict: true,
  skipLibCheck: true,
}

/**
 * Create a compiler host that resolves `.mjs` imports to `.d.mts` files.
 * Bundlers like tsdown generate `.d.mts` type declarations that import from
 * `.mjs` paths, but the `.mjs` runtime files aren't included in the package.
 * Without this fallback, TypeScript resolves those imports as `any`.
 */
export function createResolvedHost(compilerOptions?: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions ?? TS_COMPILER_OPTIONS)
  const origFileExists = host.fileExists.bind(host)
  const origGetSourceFile = host.getSourceFile.bind(host)

  host.fileExists = (fileName: string) => {
    if (origFileExists(fileName)) return true
    if (fileName.endsWith('.mjs')) {
      return existsSync(fileName.replace(/\.mjs$/, '.d.mts'))
    }
    return false
  }

  host.getSourceFile = (fileName: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions, onError?: (message: string) => void) => {
    if (fileName.endsWith('.mjs') && !existsSync(fileName)) {
      const dts = fileName.replace(/\.mjs$/, '.d.mts')
      if (existsSync(dts)) {
        const content = readFileSync(dts, 'utf-8')
        return ts.createSourceFile(fileName, content, languageVersionOrOptions, true)
      }
    }
    return origGetSourceFile(fileName, languageVersionOrOptions, onError)
  }

  return host
}

/**
 * Create a shared TypeScript program for multiple entry point files.
 * This avoids creating one ts.createProgram() per entry point, which is
 * critical for packages like date-fns (598 entry points).
 */
export function createSharedProgram(filePaths: string[]): ts.Program {
  return ts.createProgram(filePaths, TS_COMPILER_OPTIONS, createResolvedHost())
}

/**
 * Extract an API tree using an existing shared program.
 * Much faster than extractApiTree() when processing multiple entry points
 * from the same package.
 */
export function extractApiTreeFromProgram(
  program: ts.Program,
  filePath: string,
  options: ExtractOptions,
): ApiTree {
  const checker = program.getTypeChecker()
  return extractWithChecker(checker, program, filePath, options)
}

export function extractApiTree(filePath: string, options: ExtractOptions): ApiTree {
  const program = ts.createProgram([filePath], TS_COMPILER_OPTIONS, createResolvedHost())
  const checker = program.getTypeChecker()
  return extractWithChecker(checker, program, filePath, options)
}

function extractWithChecker(
  checker: ts.TypeChecker,
  program: ts.Program,
  filePath: string,
  options: ExtractOptions,
): ApiTree {
  const sourceFile = program.getSourceFile(filePath)

  if (!sourceFile) {
    throw new Error(`Could not find source file: ${filePath}`)
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) {
    options.onWarn?.(`No module symbol found for ${filePath} — file may have no exports`)
    return {
      packageName: options.packageName,
      version: options.version,
      entryPoint: options.entryPoint,
      exports: [],
    }
  }

  const exportSymbols = checker.getExportsOfModule(moduleSymbol)

  // Handle `export = x` — getExportsOfModule returns nothing for this pattern.
  // The module's value is stored under the internal 'export=' key.
  if (exportSymbols.length === 0) {
    const exportEqualsSym = (moduleSymbol.exports as ReadonlyMap<ts.__String, ts.Symbol> | undefined)?.get('export=' as unknown as ts.__String)
    if (exportEqualsSym) {
      const node = buildApiNode(exportEqualsSym, '', checker)
      if (node) {
        // Rename to 'default' for consistency with ESM default export handling
        node.name = 'default'
        node.path = 'default'
        return {
          packageName: options.packageName,
          version: options.version,
          entryPoint: options.entryPoint,
          exports: [node],
        }
      }
    }
  }

  // Filter to only explicitly exported symbols. getExportsOfModule() also returns
  // types that appear in export signatures but are not themselves exported
  // (e.g. `interface Internal {}; export function foo(x: Internal): void`).
  // Including those produces false positives when they change.
  const explicitExports = exportSymbols.filter((sym) => {
    // export default / export = — always an intentional public export
    if (sym.getName() === 'default') return true
    const decls = sym.getDeclarations()
    if (!decls || decls.length === 0) return false
    return decls.some((d) => {
      // Check the declaration and ancestor statements for an export modifier.
      // VariableDeclaration → VariableDeclarationList → VariableStatement (has export keyword)
      for (const node of [d, d.parent, d.parent?.parent]) {
        if (node && ts.canHaveModifiers(node) && node.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )) return true
      }
      // Named export: `export { Foo }` or `export { Foo } from './source'`
      if (ts.isExportSpecifier(d)) return true
      // Default export: `export default ...`
      if (ts.isExportAssignment(d)) return true
      // `export = ...`
      if (d.parent && ts.isExportAssignment(d.parent)) return true
      return false
    })
  })

  const exports: ApiNode[] = []
  const skippedNames: string[] = []

  for (const sym of explicitExports) {
    const node = buildApiNode(sym, '', checker)
    if (node) {
      exports.push(node)
    } else {
      skippedNames.push(sym.getName())
    }
  }

  if (skippedNames.length > 0) {
    options.onWarn?.(
      `Skipped ${skippedNames.length} export(s) in ${filePath}: ${skippedNames.join(', ')} — these will not appear in the diff`,
    )
  }

  const anyCount = exports.filter((e) => e.signature === 'any').length
  const ANY_THRESHOLD = 0.3
  if (anyCount > 0 && anyCount >= exports.length * ANY_THRESHOLD) {
    options.onWarn?.(
      `${anyCount} of ${exports.length} exports resolved to 'any' — type declarations may use an unsupported module format (e.g., bundler-generated .mjs imports without matching .d.mts files)`,
    )
  }

  return {
    packageName: options.packageName,
    version: options.version,
    entryPoint: options.entryPoint,
    exports,
  }
}

/**
 * Normalize compiler-internal symbol names like `__@iterator@822` to
 * stable `[Symbol.iterator]` form.  The trailing numeric suffix is an
 * internal ID that varies between compiler invocations, which causes
 * false-positive "removed + added" diffs when comparing two extractions.
 */
function normalizeSymbolName(name: string): string {
  const match = name.match(/^__@(\w+)@\d+$/)
  if (match) {
    return `[Symbol.${match[1]}]`
  }
  return name
}

function buildApiNode(
  symbol: ts.Symbol,
  parentPath: string,
  checker: ts.TypeChecker,
): ApiNode | null {
  const name = normalizeSymbolName(symbol.getName())
  const path = parentPath ? `${parentPath}.${name}` : name
  const declarations = symbol.getDeclarations()

  if (!declarations || declarations.length === 0) {
    return null
  }

  const decl = declarations[0]
  // Resolve through aliases (e.g., re-exports) to get the true declaration kind.
  // Without this, re-exported type aliases appear as 'const' and get signature 'any'.
  const resolvedSymbol = (symbol.flags & ts.SymbolFlags.Alias)
    ? checker.getAliasedSymbol(symbol)
    : symbol
  const resolvedDecl = resolvedSymbol.getDeclarations()?.[0]
  const kind = resolvedDecl
    ? determineKind(resolvedSymbol, resolvedDecl)
    : determineKind(symbol, decl)
  const type = checker.getTypeOfSymbolAtLocation(symbol, decl)
  const signature = getSignature(checker, type, resolvedSymbol, resolvedDecl ?? decl, kind)
  const effectiveDecl = resolvedDecl ?? decl
  const position = determinePosition(kind, effectiveDecl)
  const modifiers = extractModifiers(effectiveDecl, resolvedSymbol)
  const children = buildChildren(resolvedSymbol, effectiveDecl, path, checker, kind, type)

  // Extract JSDoc tags from the resolved (non-alias) symbol
  const tagDecl = resolvedSymbol.getDeclarations()?.[0]
  const jsdocTags = tagDecl ? ts.getJSDocTags(tagDecl) : []
  const tags = jsdocTags.map(t => t.tagName.text)

  // For nodes with children (interfaces, classes, etc.), incorporate children
  // into the typeId so that structural changes are detected by the fast path.
  let typeId: string
  if (children.length > 0) {
    const childIds = children.map((c) => `${c.name}:${c.typeId}:${c.modifiers.optional ?? false}:${c.modifiers.readonly ?? false}:${c.modifiers.visibility ?? ''}:${c.modifiers.abstract ?? false}:${c.modifiers.hasDefault ?? false}:${c.modifiers.isRest ?? false}`).join(',')
    typeId = computeTypeId(`${signature}|${childIds}`)
  } else {
    typeId = computeTypeId(signature)
  }

  return {
    name,
    path,
    kind,
    signature,
    children,
    typeId,
    position,
    modifiers,
    ...(tags.length > 0 ? { tags } : {}),
  }
}

function determineKind(symbol: ts.Symbol, decl: ts.Declaration): NodeKind {
  if (ts.isInterfaceDeclaration(decl)) return 'interface'
  if (ts.isTypeAliasDeclaration(decl)) return 'type-alias'
  if (ts.isFunctionDeclaration(decl)) return 'function'
  if (ts.isClassDeclaration(decl)) return 'class'
  if (ts.isEnumDeclaration(decl)) return 'enum'
  if (ts.isModuleDeclaration(decl)) return 'namespace'
  if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) return 'method'
  if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) return 'property'
  if (ts.isParameter(decl)) return 'parameter'

  // Check symbol flags as fallback
  if (symbol.flags & ts.SymbolFlags.Interface) return 'interface'
  if (symbol.flags & ts.SymbolFlags.TypeAlias) return 'type-alias'
  if (symbol.flags & ts.SymbolFlags.Function) return 'function'
  if (symbol.flags & ts.SymbolFlags.Class) return 'class'
  if (symbol.flags & ts.SymbolFlags.Enum) return 'enum'
  if (symbol.flags & ts.SymbolFlags.NamespaceModule) return 'namespace'
  if (symbol.flags & ts.SymbolFlags.Method) return 'method'
  if (symbol.flags & ts.SymbolFlags.Property) return 'property'

  // Variable declarations (const, let, var)
  if (ts.isVariableDeclaration(decl)) return 'const'
  if (symbol.flags & ts.SymbolFlags.Variable) return 'const'

  return 'const'
}

function getSignature(
  checker: ts.TypeChecker,
  type: ts.Type,
  symbol: ts.Symbol,
  decl: ts.Declaration,
  kind: NodeKind,
): string {
  if (kind === 'type-alias' && ts.isTypeAliasDeclaration(decl)) {
    // For type aliases, expand the underlying type using InTypeAlias flag
    // so we get e.g. '"a" | "b" | "c"' instead of just the alias name
    const aliasType = checker.getDeclaredTypeOfSymbol(symbol)
    const raw = checker.typeToString(
      aliasType,
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
    )
    return normalizeImportPaths(raw)
  }

  if (kind === 'interface') {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol)
    const raw = checker.typeToString(
      declaredType,
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
    return normalizeImportPaths(raw)
  }

  if (kind === 'enum') {
    const raw = checker.typeToString(
      checker.getDeclaredTypeOfSymbol(symbol),
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
    return normalizeImportPaths(raw)
  }

  const raw = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
  return normalizeImportPaths(raw)
}

/**
 * Normalize `typeof import("/tmp/.../pkg@1.0.0/lib/foo")` paths so that two
 * extractions of the same package from different temp directories produce
 * identical signatures.
 *
 * Strips the cache/temp directory prefix (everything before the package's
 * internal path structure) while preserving enough path to disambiguate
 * distinct modules (e.g., `lib/foo` vs `lib/bar`).
 */
function normalizeImportPaths(sig: string): string {
  return sig.replace(
    /typeof import\("([^"]*)"\)/g,
    (_match, fullPath: string) => {
      // Strip common temp/cache prefixes: keep path from the package root.
      // Patterns: /tmp/typediff-cache/pkg@1.0.0/lib/foo → lib/foo
      //           /var/.../typediff-cache/pkg@1.0.0/dist/types → dist/types
      //           /node_modules/pkg/lib/foo → lib/foo
      const cacheMatch = fullPath.match(/typediff-cache\/[^/]+\/(.+)$/)
      if (cacheMatch) return `typeof import("${cacheMatch[1]}")`

      const nmMatch = fullPath.match(/node_modules\/(?:@[^/]+\/)?[^/]+\/(.+)$/)
      if (nmMatch) return `typeof import("${nmMatch[1]}")`

      // Fallback: keep the last two path segments to avoid collisions
      // between distinct modules with the same filename (e.g., a/types vs b/types)
      const parts = fullPath.split('/')
      const KEEP_SEGMENTS = 2
      const kept = parts.length >= KEEP_SEGMENTS ? parts.slice(-KEEP_SEGMENTS).join('/') : fullPath
      return `typeof import("${kept}")`
    },
  )
}

/**
 * Split a type string by a top-level delimiter (' | ' or ' & '),
 * respecting nested braces, angle brackets, and parentheses.
 */
function splitTopLevel(sig: string, delimiter: string): string[] {
  const members: string[] = []
  let depth = 0
  let current = ''

  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string/template literal content at any depth to avoid misinterpreting
      // |, {, }, <, > inside strings (e.g., { kind: "List<string>" }, `prefix-${string}`)
      current += ch
      i++
      while (i < sig.length && sig[i] !== ch) {
        if (sig[i] === '\\') { current += sig[i++] } // skip escaped char
        if (i < sig.length) current += sig[i++]
      }
      if (i < sig.length) current += sig[i]
    } else if (ch === '{' || ch === '<' || ch === '(' || ch === '[') {
      depth++
      current += ch
    } else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') {
      depth--
      current += ch
    } else if (
      depth === 0 &&
      sig.slice(i, i + delimiter.length) === delimiter
    ) {
      members.push(current.trim())
      current = ''
      i += delimiter.length - 1
    } else {
      current += ch
    }
  }

  const last = current.trim()
  if (last) members.push(last)
  return members
}

function normalizeIntersection(sig: string): string {
  if (sig.includes(' & ')) {
    const members = splitTopLevel(sig, ' & ')
    if (members.length > 1) {
      members.sort()
      return members.join(' & ')
    }
  }
  return sig
}

function normalizeTypeString(sig: string): string {
  // Sort union members at top level, normalizing intersections within each member
  if (sig.includes(' | ')) {
    const members = splitTopLevel(sig, ' | ')
    if (members.length > 1) {
      return members.map(normalizeIntersection).sort().join(' | ')
    }
  }
  // Sort intersection members at top level only
  return normalizeIntersection(sig)
}

function computeTypeId(signature: string): string {
  const normalized = normalizeTypeString(signature)
  return createHash('sha256').update(normalized).digest('hex')
}

function determinePosition(kind: NodeKind, decl: ts.Declaration): Position {
  if (kind === 'parameter') return 'input'
  if (kind === 'return-type') return 'output'
  if (kind === 'const') return 'output'
  if (kind === 'enum') return 'output'
  if (kind === 'function') return 'output'

  // Properties: readonly = output, mutable = invariant
  if (kind === 'property') {
    let hasReadonly = false
    if (ts.canHaveModifiers(decl) && decl.modifiers) {
      hasReadonly = decl.modifiers.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)
    }
    // Fallback for PropertySignature in case canHaveModifiers differs across TS versions
    if (!hasReadonly && ts.isPropertySignature(decl) && decl.modifiers) {
      hasReadonly = decl.modifiers.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)
    }
    return hasReadonly ? 'output' : 'invariant'
  }

  // interfaces, classes, type-aliases, methods, namespaces
  if (kind === 'interface' || kind === 'class' || kind === 'type-alias' || kind === 'namespace') {
    return 'invariant'
  }

  if (kind === 'method') return 'invariant'

  return 'invariant'
}

function extractModifiers(decl: ts.Declaration, symbol: ts.Symbol): Modifiers {
  const modifiers: Modifiers = {}

  // Check for optional
  if (symbol.flags & ts.SymbolFlags.Optional) {
    modifiers.optional = true
  }

  // Also check for question token on property/parameter
  if (
    (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl) || ts.isParameter(decl)) &&
    decl.questionToken
  ) {
    modifiers.optional = true
  }

  if (ts.canHaveModifiers(decl) && decl.modifiers) {
    for (const mod of decl.modifiers) {
      switch (mod.kind) {
        case ts.SyntaxKind.ReadonlyKeyword:
          modifiers.readonly = true
          break
        case ts.SyntaxKind.AbstractKeyword:
          modifiers.abstract = true
          break
        case ts.SyntaxKind.PublicKeyword:
          modifiers.visibility = 'public'
          break
        case ts.SyntaxKind.ProtectedKeyword:
          modifiers.visibility = 'protected'
          break
        case ts.SyntaxKind.PrivateKeyword:
          modifiers.visibility = 'private'
          break
      }
    }
  }

  // Check for default value / initializer on parameters
  if (ts.isParameter(decl) && decl.initializer) {
    modifiers.hasDefault = true
  }

  // Check for rest parameter
  if (ts.isParameter(decl) && decl.dotDotDotToken) {
    modifiers.isRest = true
  }

  return modifiers
}

function extractIndexSignatures(
  type: ts.Type,
  parentPath: string,
  checker: ts.TypeChecker,
  children: ApiNode[],
): void {
  const indexInfos = checker.getIndexInfosOfType(type)
  for (let i = 0; i < indexInfos.length; i++) {
    const info = indexInfos[i]
    const keyStr = checker.typeToString(info.keyType, undefined, ts.TypeFormatFlags.NoTruncation)
    const valStr = checker.typeToString(info.type, undefined, ts.TypeFormatFlags.NoTruncation)
    const ro = info.isReadonly ? 'readonly ' : ''
    const sig = `${ro}[key: ${keyStr}]: ${valStr}`
    const name = `[index:${keyStr}]`
    children.push({
      name,
      path: `${parentPath}.${name}`,
      kind: 'property',
      signature: sig,
      children: [],
      typeId: computeTypeId(sig),
      position: info.isReadonly ? 'output' : 'invariant',
      modifiers: { readonly: info.isReadonly || undefined },
    })
  }
}

function extractCallSignaturesAsChildren(
  type: ts.Type,
  parentPath: string,
  checker: ts.TypeChecker,
  children: ApiNode[],
): void {
  const callSigs = type.getCallSignatures()
  for (let i = 0; i < callSigs.length; i++) {
    const sig = callSigs[i]
    const params = sig.parameters.map((p) => {
      const decls = p.getDeclarations()
      if (!decls || decls.length === 0) return `${p.getName()}: any`
      const paramType = checker.getTypeOfSymbolAtLocation(p, decls[0])
      return `${p.getName()}: ${checker.typeToString(paramType, undefined, ts.TypeFormatFlags.NoTruncation)}`
    })
    const returnType = checker.typeToString(sig.getReturnType(), undefined, ts.TypeFormatFlags.NoTruncation)
    const sigStr = `(${params.join(', ')}) => ${returnType}`
    const name = callSigs.length === 1 ? '[call]' : `[call:${i}]`
    children.push({
      name,
      path: `${parentPath}.${name}`,
      kind: 'method',
      signature: sigStr,
      children: [],
      typeId: computeTypeId(sigStr),
      position: 'invariant',
      modifiers: {},
    })
  }
}

function extractConstructSignatures(
  type: ts.Type,
  parentPath: string,
  checker: ts.TypeChecker,
  children: ApiNode[],
): void {
  const constructSigs = type.getConstructSignatures()
  for (let i = 0; i < constructSigs.length; i++) {
    const sig = constructSigs[i]
    const params = sig.parameters.map((p) => {
      const decls = p.getDeclarations()
      if (!decls || decls.length === 0) return `${p.getName()}: any`
      const paramType = checker.getTypeOfSymbolAtLocation(p, decls[0])
      return `${p.getName()}: ${checker.typeToString(paramType, undefined, ts.TypeFormatFlags.NoTruncation)}`
    })
    const returnType = checker.typeToString(sig.getReturnType(), undefined, ts.TypeFormatFlags.NoTruncation)
    const sigStr = `new (${params.join(', ')}) => ${returnType}`
    const name = constructSigs.length === 1 ? '[new]' : `[new:${i}]`
    children.push({
      name,
      path: `${parentPath}.${name}`,
      kind: 'method',
      signature: sigStr,
      children: [],
      typeId: computeTypeId(sigStr),
      position: 'invariant',
      modifiers: {},
    })
  }
}

function buildChildren(
  symbol: ts.Symbol,
  decl: ts.Declaration,
  parentPath: string,
  checker: ts.TypeChecker,
  kind: NodeKind,
  type: ts.Type,
): ApiNode[] {
  const children: ApiNode[] = []

  if (kind === 'interface') {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol)
    const props = declaredType.getProperties()
    for (const prop of props) {
      const name = prop.getName()
      if (name.startsWith('#')) continue // ES private field — not public API
      const propNode = buildApiNode(prop, parentPath, checker)
      if (propNode) {
        children.push(propNode)
      }
    }
    // Extract index signatures (e.g., [key: string]: unknown)
    extractIndexSignatures(declaredType, parentPath, checker, children)
    // Extract call signatures (e.g., interface Fn { (x: number): void })
    extractCallSignaturesAsChildren(declaredType, parentPath, checker, children)
    // Extract construct signatures (e.g., interface Factory { new(x: string): Foo })
    extractConstructSignatures(declaredType, parentPath, checker, children)
  } else if (kind === 'class') {
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol)
    const props = declaredType.getProperties()
    for (const prop of props) {
      const name = prop.getName()
      if (name.startsWith('#')) continue // ES private field — not public API

      // Skip private members - they're not public API
      const propDecls = prop.getDeclarations()
      if (propDecls && propDecls.length > 0) {
        const propDecl = propDecls[0]
        if (ts.canHaveModifiers(propDecl) && propDecl.modifiers) {
          const isPrivate = propDecl.modifiers.some(
            (m) => m.kind === ts.SyntaxKind.PrivateKeyword,
          )
          if (isPrivate) continue
        }
      }

      const propNode = buildApiNode(prop, parentPath, checker)
      if (propNode) {
        children.push(propNode)
      }
    }
    // Extract index signatures for classes too
    extractIndexSignatures(declaredType, parentPath, checker, children)
  } else if (kind === 'function' || kind === 'method') {
    const signatures = type.getCallSignatures()
    if (signatures.length > 0) {
      const sig = signatures[0]

      // Add parameters from the first overload.
      // Note: for overloaded functions, only the first overload's parameters
      // appear as children. The full set of overloads is captured in the
      // parent's signature (via typeToString), so any overload change is
      // detected via typeId. The child-level diff attributes the change to
      // the first overload's parameter structure.
      for (const param of sig.parameters) {
        const paramNode = buildApiNode(param, parentPath, checker)
        if (paramNode) {
          paramNode.kind = 'parameter'
          paramNode.position = 'input'
          children.push(paramNode)
        }
      }

      // Add return type
      const returnType = sig.getReturnType()
      const returnSig = checker.typeToString(
        returnType,
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      )
      children.push({
        name: 'return',
        path: `${parentPath}.return`,
        kind: 'return-type',
        signature: returnSig,
        children: [],
        typeId: computeTypeId(returnSig),
        position: 'output',
        modifiers: {},
      })
    }
    // Declaration merging: if the symbol also has namespace members (e.g., function + namespace),
    // extract them so that adding/removing namespace properties is detected.
    // ValueModule covers `declare namespace` merged with a function declaration.
    if (symbol.flags & (ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule)) {
      const nsExports = checker.getExportsOfModule(symbol)
      for (const nsSym of nsExports) {
        const nsNode = buildApiNode(nsSym, parentPath, checker)
        if (nsNode) {
          children.push(nsNode)
        }
      }
    }
  } else if (kind === 'namespace') {
    // Extract namespace members via module exports
    const nsExports = checker.getExportsOfModule(symbol)
    for (const nsSym of nsExports) {
      const nsNode = buildApiNode(nsSym, parentPath, checker)
      if (nsNode) {
        children.push(nsNode)
      }
    }
  } else if (kind === 'enum') {
    if (ts.isEnumDeclaration(decl)) {
      for (const member of decl.members) {
        const memberName = member.name.getText()
        const memberType = checker.getTypeAtLocation(member)
        const memberSig = checker.typeToString(
          memberType,
          undefined,
          ts.TypeFormatFlags.NoTruncation,
        )
        children.push({
          name: memberName,
          path: `${parentPath}.${memberName}`,
          kind: 'property',
          signature: memberSig,
          children: [],
          typeId: computeTypeId(memberSig),
          position: 'output',
          modifiers: {},
        })
      }
    }
  }

  // Extract type parameters for generic declarations
  const typeParamDecl = symbol.getDeclarations()?.[0]
  if (typeParamDecl && (
    ts.isFunctionDeclaration(typeParamDecl) ||
    ts.isMethodDeclaration(typeParamDecl) ||
    ts.isMethodSignature(typeParamDecl) ||
    ts.isClassDeclaration(typeParamDecl) ||
    ts.isInterfaceDeclaration(typeParamDecl) ||
    ts.isTypeAliasDeclaration(typeParamDecl)
  ) && typeParamDecl.typeParameters) {
    for (const tp of typeParamDecl.typeParameters) {
      const constraint = tp.constraint
        ? checker.typeToString(
            checker.getTypeFromTypeNode(tp.constraint),
            undefined,
            ts.TypeFormatFlags.NoTruncation,
          )
        : undefined
      const defaultType = tp.default
        ? checker.typeToString(
            checker.getTypeFromTypeNode(tp.default),
            undefined,
            ts.TypeFormatFlags.NoTruncation,
          )
        : undefined

      const sigParts = [constraint ?? 'unknown']
      if (defaultType) sigParts.push(`= ${defaultType}`)
      const sig = sigParts.join(' ')

      children.push({
        name: tp.name.text,
        path: `${parentPath}.${tp.name.text}`,
        kind: 'type-parameter',
        signature: sig,
        position: 'input',
        modifiers: { hasDefault: !!defaultType },
        typeId: computeTypeId(normalizeTypeString(sig)),
        children: [],
      })
    }
  }

  return children
}
