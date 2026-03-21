# typediff

**Verify semver accuracy by diffing TypeScript types between package versions.**

[![npm version](https://img.shields.io/npm/v/typediff)](https://www.npmjs.com/package/typediff)
[![CI](https://github.com/danfry1/typediff/actions/workflows/ci.yml/badge.svg)](https://github.com/danfry1/typediff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

npm semver is based on the honour system. `typediff` verifies it by actually diffing the types. Dependabot merges a "minor" bump on Friday, your build breaks Monday morning -- `typediff` catches that before it ships.

## Quick Start

```bash
npx typediff inspect zod@3.22.0 zod@3.23.0
```

```
  typediff  zod 3.22.0 → 3.23.0

  Claimed   minor
  Actual    major ✖ MISMATCH

  2 breaking  ·  39 minor  ·  67 compatible

   BREAKING

  ✖ ZodStringCheck
    Union type widened — new variants may break exhaustive switches

  ✖ StringValidation
    Union type widened — new variants may break exhaustive switches

   MINOR

  + datetimeRegex  New function
  + ZodString.nanoid  New method
  + ZodString.base64  New method
  ... and 36 more minor changes

  COMPATIBLE (67 changes verified as non-breaking)

  Done in 1.4s
```

Zod 3.23.0 claims to be a minor bump, but it widens union types -- anyone with exhaustive `switch` statements breaks at compile time. `typediff` catches this.

## What It Does

typediff uses the TypeScript compiler to structurally compare the public API between two package versions. It doesn't trust the author's semver claim -- it verifies it.

- **Catches breaking changes** hidden in minor/patch bumps
- **Zero false positives** -- uses TypeScript's own assignability checker
- **Tested against real packages** -- lodash, axios, zod, TypeScript, drizzle-orm, react, vitest, and more

## Install

```bash
npm install -g typediff
# or run directly
npx typediff inspect <pkg@old> <pkg@new>
```

## Usage

### Compare two versions

```bash
typediff inspect zod@3.22.0 zod@3.23.0
```

### Auto-detect previous version

```bash
typediff inspect zod@3.23.0
# Automatically finds 3.22.0 and compares
```

### Compare a local build against the published version

```bash
npm run build
typediff inspect ./dist my-lib@latest
```

### Auto-detect from local package

```bash
npm run build
typediff inspect ./dist
# Reads package.json, finds the previous npm version, and compares
```

### CI with exit codes

```bash
typediff inspect zod@3.22.0 zod@3.23.0 --exit-code
# Exit 0 = no breaking changes
# Exit 1 = breaking changes found
# Exit 2 = operational error
```

### Filter by severity

```bash
typediff inspect zod@3.22.0 zod@3.23.0 --severity major
```

### Ignore specific exports

```bash
typediff inspect zod@3.22.0 zod@3.23.0 --ignore "internal.*" --ignore "unstable.*"
```

### Honor TSDoc tags

```bash
typediff inspect my-lib@1.0.0 my-lib@2.0.0 --respect-tags
# @internal/@alpha breaking changes → patch
# @beta breaking changes → minor
# @deprecated removals → minor
```

### Snapshots

Save the API surface for later comparison:

```bash
typediff snapshot ./dist -o baseline.json
# ... make changes ...
typediff compare baseline.json ./dist
```

### Monorepo workspaces

Scan all publishable workspace packages:

```bash
typediff --workspaces
typediff --workspaces --filter "packages/core-*"
```

## For Library Authors

Run before every publish to catch accidental breaking changes:

```bash
npm run build
typediff inspect ./dist
# Reads your package.json, finds the last published version, and diffs
```

Add to your CI:

```bash
typediff inspect ./dist --exit-code
```

Or add to `prepublishOnly`:

```json
{
  "scripts": {
    "prepublishOnly": "typediff inspect ./dist --exit-code"
  }
}
```

## GitHub Action

Zero-config type verification for dependency PRs:

```yaml
name: Verify Dependency Updates
on:
  pull_request:
    paths:
      - 'package.json'
      - 'package-lock.json'

jobs:
  verify-deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: danfry1/typediff@v1
```

The action compares type definitions for every dependency changed in the PR, posts a comment summarizing the results, and fails the check if a "minor" or "patch" bump actually contains breaking type changes.

### Action Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `severity` | Minimum severity to report (`major`, `minor`, `patch`) | `minor` |
| `fail-on` | Fail when actual semver exceeds claimed (`major`, `minor`, `never`) | `major` |
| `ignore` | Packages to skip (comma-separated glob patterns) | |
| `github-token` | GitHub token for comments and check status | `${{ github.token }}` |

### Action Outputs

| Output | Description |
|--------|-------------|
| `result` | Whether the check passed or failed (`pass` / `fail`) |
| `actual-semver` | Highest actual semver level detected (`major`, `minor`, `patch`) |

Use outputs in downstream steps:

```yaml
- uses: danfry1/typediff@v1
  id: typediff
- run: echo "Result: ${{ steps.typediff.outputs.result }}"
```

## How It Works

1. Downloads both package versions from npm (or resolves local paths)
2. Extracts the public API surface using the TypeScript compiler
3. Structurally diffs the API trees -- interfaces, types, functions, classes, enums, and namespaces
4. Uses TypeScript's assignability checker to verify compatibility and eliminate false positives
5. Classifies each change as major, minor, or patch

## Accuracy

Validated against real-world packages with known changes:

| Package | Versions | Claimed | Actual | Result |
|---------|----------|---------|--------|--------|
| lodash | 4.17.20 -> 4.17.21 | patch | patch | Clean |
| axios | 1.7.2 -> 1.7.3 | patch | patch | Clean |
| express | 4.18.2 -> 4.19.0 | minor | minor | Clean |
| react | 18.2.0 -> 18.3.0 | minor | minor | Clean |
| jose | 5.2.0 -> 5.3.0 | minor | minor | Clean |
| vitest | 2.0.0 -> 2.1.0 | minor | minor | Clean |
| date-fns | 3.0.0 -> 3.1.0 | minor | minor | Clean |
| zod | 3.22.0 -> 3.23.0 | minor | **major** | Breaking: discriminated union widenings |
| typescript | 5.6.2 -> 5.7.2 | minor | **major** | Breaking: API removals and type changes |
| drizzle-orm | 0.30.0 -> 0.31.0 | 0.x minor | **major** | Breaking: removed exports, new required members |

## Options

```
Usage:
  typediff inspect <pkg@version>             (auto-detect previous version)
  typediff inspect <pkg@old> <pkg@new>
  typediff inspect ./local-path <pkg@version>
  typediff inspect ./local-path              (auto-detect from package.json)
  typediff snapshot <path> [-o <file>]
  typediff compare <snapshot.json> <path-or-pkg@version>

Options:
  --format <json|pretty>   Output format (default: auto-detect TTY)
  --severity <level>       Minimum severity: major, minor, patch
  --ignore <pattern>       Glob pattern to ignore (repeatable)
  --respect-tags           Honor @internal/@beta/@public TSDoc tags
  --verbose                Show all changes including compatible ones
  --quiet, -q              One-line verdict output
  --exit-code              Exit 1 if breaking changes found
  --include-internals      Include _-prefixed internal members
  --workspaces             Scan all workspace packages
  --filter <glob>          Filter workspaces (with --workspaces)
  --registry <url>         Custom npm registry URL (also reads .npmrc)
  --debug                  Show diagnostic debug output
  -h, --help               Show this help
  -v, --version            Show version

Exit codes:
  0  Success (or no breaking changes with --exit-code)
  1  Breaking changes detected (with --exit-code)
  2  Operational error
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HTTPS_PROXY` / `https_proxy` | HTTP(S) proxy URL for npm registry requests |
| `HTTP_PROXY` / `http_proxy` | Fallback proxy URL |
| `NO_PROXY` / `no_proxy` | Comma-separated hosts to bypass proxy (or `*` for all) |
| `NO_COLOR` | Disable colored output (see [no-color.org](https://no-color.org)) |
| `FORCE_COLOR` | Force colored output even when not a TTY |

## Configuration

Create a `.typediffrc.json` in your project root:

```json
{
  "ignore": ["internal.*", "unstable.*"],
  "severity": "minor",
  "exitCode": true,
  "respectTags": true,
  "quiet": false
}
```

CLI flags override config file values.

## Programmatic API

```typescript
import { diff, diffLocal, diffMixed } from 'typediff'

// Compare two npm versions
const result = await diff('zod', '3.22.0', '3.23.0')

console.log(result.claimedSemver) // 'minor'
console.log(result.actualSemver)  // 'major'

const breaking = result.changes.filter(c => c.semver === 'major')
// [{ path: 'ZodStringCheck', kind: 'changed', semver: 'major', ... }]

// Compare local builds
const local = await diffLocal('./old-dist', './new-dist')

// Compare local against npm
const mixed = await diffMixed('./dist', 'my-lib', '1.0.0', false)
```

> **Tip:** The main `typediff` import provides the most commonly used functions. For advanced building blocks (resolvers, refinement, shared programs), use `import { ... } from 'typediff/advanced'`.

### Exported Functions

| Function | Description |
|----------|-------------|
| `diff(name, oldVersion, newVersion, options?)` | Compare two npm-published versions |
| `diffLocal(oldPath, newPath, options?)` | Compare two local package directories |
| `diffMixed(localPath, npmPkg, npmVersion, localIsOld, options?)` | Compare local against npm |
| `extractApiTree(dtsPath, meta)` | Extract the public API tree from a `.d.ts` file |
| `diffApiTrees(oldTree, newTree)` | Diff two API trees |
| `classifyChange(change, oldNode?, newNode?)` | Classify a single change as major/minor/patch |
| `checkCompatibility(oldDts, newDts, exports)` | Run TypeScript assignability checks |
| `createSnapshot(localPath)` | Save API surface to a snapshot |
| `loadSnapshot(filePath)` | Load a previously saved snapshot |

### Types

```typescript
interface ChangeSet {
  packageName: string
  oldVersion: string
  newVersion: string
  changes: Change[]
  actualSemver: SemverLevel    // 'major' | 'minor' | 'patch'
  claimedSemver?: SemverLevel
}

interface Change {
  kind: ChangeKind        // 'added' | 'removed' | 'changed'
  path: string            // e.g. 'ZodStringCheck' or 'ColumnBuilder.$onUpdate'
  semver: SemverLevel
  description: string
  oldSignature?: string
  newSignature?: string
}
```

## Troubleshooting

**"No type definitions found"** — The package doesn't ship `.d.ts` files and has no `@types/` package. typediff can only analyze packages with TypeScript type definitions.

**"Request to npm registry timed out"** — Check your internet connection. Behind a corporate proxy? Set `HTTPS_PROXY=http://your-proxy:8080`.

**"Failed to extract package tarball"** — On Windows without `tar` in PATH, typediff falls back to a built-in extractor. If extraction still fails, try clearing the cache: `rm -rf $TMPDIR/typediff-cache`.

**Private registry packages** — typediff reads `.npmrc` for auth tokens and scoped registries. Use `--registry <url>` to override, or configure your `.npmrc`:
```ini
@mycompany:registry=https://npm.mycompany.com/
//npm.mycompany.com/:_authToken=YOUR_TOKEN
```

**Monorepo: packages not found** — Workspace scanning walks up to 10 directories deep. If your packages are deeper, check your `workspaces` globs in `package.json`.

**Subpath changes not detected** — typediff discovers subpath entry points from `exports` and `typesVersions`. Without either, only the root entry point (`types`, `typings`, or `index.d.ts`) is analyzed. Add an `exports` map to declare subpath entry points:
```json
{ "exports": { ".": { "types": "./dist/index.d.ts" }, "./utils": { "types": "./dist/utils.d.ts" } } }
```

## License

MIT
