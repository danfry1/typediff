# Changelog

All notable changes to typediff will be documented in this file.

## [0.2.0] - 2026-03-29

### Added
- Multi-entry point support for packages with `exports` map
- `snapshot` and `compare` commands for CI baseline workflows
- Workspace scanning with `--workspaces` and `--filter`
- TSDoc tag support with `--respect-tags` flag — tag downgrade reasons shown in output
- RC file configuration via `.typediffrc.json`
- `diffMixed()` programmatic API for local-vs-npm comparisons
- `typediff/advanced` subpath export for custom diffing pipelines
- `--quiet` flag for one-line verdict output
- `--json` shorthand for `--format json`
- `--include-internals` flag to include `_`-prefixed internal members
- `--registry` flag and `.npmrc` support for private registries
- `--debug` flag for diagnostic output
- Automatic `@types/*` fallback when packages lack bundled types
- Bundler compatibility: resolve `.mjs` → `.d.mts` imports from tsdown/tsup/rollup-plugin-dts output
- Diagnostic warning when exports resolve to `any` (indicates unsupported type declaration format)
- GitHub Action for verifying dependency type changes in PRs
- Parallel npm resolution for faster `diff()` comparisons
- Warning on extra positional arguments
- Filter underscore-prefixed internal members by default

### Fixed
- `--workspaces` now works without requiring `inspect` command
- False positives from union member reordering
- False positives from TypeScript internal symbol name instability
- Circular type handling in serialization
- Correctly classify added type parameters on classes as major
- Correctly classify added type parameters on functions/methods as minor
- Re-exported type aliases now correctly detected (were misclassified as `const` with signature `any`)
- Test artifacts no longer compiled into `dist/` (separate build tsconfig)

### Changed
- `Change.oldNode` and `Change.newNode` marked as `@internal` — use `oldSignature`/`newSignature` for display
- Release-please config consolidated to config file (removed redundant inline config)

## [0.1.0] - 2026-03-21

### Added
- Initial release
- `inspect` command for comparing npm package versions
- TypeScript assignability checker for zero false positives
- Pretty and JSON output formats
- `--severity`, `--ignore`, `--exit-code` flags
- Programmatic API: `diff()`, `diffLocal()`
