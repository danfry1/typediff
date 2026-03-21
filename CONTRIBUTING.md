# Contributing to typediff

## Getting Started

```bash
# Clone and install
git clone https://github.com/danfry1/typediff.git
cd typediff
bun install

# Run tests
cd packages/typediff
bun run test

# Typecheck
bun run typecheck

# Build
bun run build
```

## Project Structure

```
packages/typediff/     # Published npm package
  src/core/            # Extraction, diffing, classification, compatibility
  src/cli/             # CLI commands, formatters, spinner
  src/resolver/        # npm and local package resolution
action/                # GitHub Action for verifying dependency PRs
```

## Development

- **Runtime:** Node >= 18, bun for package management
- **Tests:** Vitest — run with `bun run test`
- **Style:** TypeScript strict mode, ESM only, zero unnecessary dependencies

### Running Tests

```bash
# Unit + integration tests (fast, no network)
bun run vitest run --exclude='**/real-packages*'

# Real-world package tests (requires network, slower)
bun run vitest run src/__tests__/real-packages.test.ts

# Single test file
bun run vitest run src/__tests__/differ.test.ts
```

### Architecture

The core pipeline: **extract** → **diff** → **classify** → **refine** → **format**

1. `extractor.ts` uses the TypeScript compiler API to build an `ApiTree` from `.d.ts` files
2. `differ.ts` compares two `ApiTree`s and produces `Change[]`
3. `classifier.ts` assigns semver levels based on change kind and position
4. `compatibility.ts` + `refine.ts` use TS assignability checks to eliminate false positives
5. Formatters in `cli/formatters/` render the results

### Key Principle

**Zero false positives.** Every change reported as breaking must actually break consumer code. When in doubt, downgrade severity rather than over-report.

### Known Limitations

**Overload attribution:** For overloaded functions, only the first overload's parameters appear as children in the `ApiTree`. The full set of overloads is captured in the parent node's `signature` (via TypeScript's `typeToString`), so any change to any overload IS detected via `typeId`. The diff just attributes the change to the first overload's parameter structure. A structural fix would require the differ to understand overload transitions (1→N overloads), which risks false positives when the child structure shape changes — contrary to the zero-false-positives principle.

## Pull Requests

- Keep PRs focused on a single concern
- Add tests for new behavior
- Run `bun run typecheck` before submitting
- Real-world package tests run on `main` — if your change affects classification, verify locally
