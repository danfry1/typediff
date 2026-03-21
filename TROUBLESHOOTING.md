# Troubleshooting

Common issues and how to resolve them when running typediff in CI or locally.

## Cache Issues

### "Failed to extract package tarball"

The local cache at `$TMPDIR/typediff-cache/` may be corrupted (e.g., from a killed process mid-download).

```bash
rm -rf /tmp/typediff-cache
```

On CI, this directory is typically fresh per job. If you see this on a persistent runner, add cache cleanup to your CI config.

### Stale cache after registry migration

If you switched registries (e.g., moved from npmjs.org to JFrog), the cache may contain packages from the old registry.

```bash
rm -rf /tmp/typediff-cache
```

## Network Issues

### "Could not reach npm registry"

1. Check your internet connection
2. If behind a corporate proxy, set `HTTPS_PROXY`:
   ```bash
   export HTTPS_PROXY=http://proxy.mycompany.com:8080
   ```
3. If using a private registry, pass `--registry`:
   ```bash
   typediff inspect my-pkg@1.0.0 my-pkg@2.0.0 --registry https://jfrog.mycompany.io/api/npm/npm-virtual/
   ```

### "Request to npm registry timed out"

The default timeout is 30 seconds per request. On slow networks:

1. Retry — transient timeouts are common
2. Check if the npm registry is experiencing issues: https://status.npmjs.org
3. If behind a VPN, try disconnecting and reconnecting

### "npm registry rate limit after 3 retries"

You're hitting npm's rate limit. This happens when:
- Running typediff on many packages in quick succession (e.g., `--workspaces` on a large monorepo)
- CI runs multiple typediff instances concurrently

Wait a few minutes and retry. For large-scale usage, consider using a private registry mirror.

## Private Registry Issues

### Authentication fails (401/403)

typediff reads auth tokens from `.npmrc` in this order:
1. Project-level `.npmrc` (in your repo root)
2. User-level `~/.npmrc`

Ensure your `.npmrc` has the correct auth token:

```ini
# Global registry
registry=https://jfrog.mycompany.io/api/npm/npm-virtual/
//jfrog.mycompany.io/api/npm/npm-virtual/:_authToken=YOUR_TOKEN

# Or scoped (only @mycompany packages go to JFrog)
@mycompany:registry=https://jfrog.mycompany.io/api/npm/npm-local/
//jfrog.mycompany.io/api/npm/npm-local/:_authToken=YOUR_TOKEN
```

On CI, ensure the token is set via environment variable or CI secrets.

### "Package not found" for private packages

1. Verify the package exists on your private registry
2. Check that the registry URL is correct (no trailing path issues)
3. Ensure the auth token has read permissions

## Type Definition Issues

### "No type definitions found"

The package doesn't ship types. typediff will automatically try `@types/<package>`:

1. If `@types/<package>` doesn't exist either, the package can't be analyzed
2. Some packages ship types under a non-standard path — check the package's `package.json` for `types`, `typings`, or `exports["."].types`

### Incorrect or missing changes

If typediff reports no changes when you expect some:

1. Run with `--verbose` to see progress and warnings:
   ```bash
   typediff inspect pkg@old pkg@new --verbose
   ```
2. Check for warnings about skipped exports — these indicate the extractor couldn't resolve some symbols
3. Try `--include-internals` if the changed API starts with `_`
4. Use `--format json` to inspect the raw output

### False positives (changes reported that aren't real)

1. Check if the change is a cosmetic type representation difference (TypeScript may print the same type differently across versions)
2. Run with `--format json` to see the old and new signatures
3. File an issue with the package name, old version, and new version — we track these to improve accuracy

## CI Integration Issues

### Exit code is always 0

You need `--exit-code` to get non-zero exit on breaking changes:

```bash
typediff inspect pkg@old pkg@new --exit-code
# Exit 0 = no breaking changes
# Exit 1 = breaking changes found
# Exit 2 = operational error
```

### GitHub Action not posting comments

1. Ensure the `github-token` input has permission to write comments
2. Check the action logs for warnings about skipped packages
3. Verify the lockfile is included in the PR diff (`paths` filter in workflow)

### "--workspaces" skips packages silently

typediff skips:
- Private packages (`"private": true` in package.json)
- Packages not published to npm (first-time publish — use `typediff snapshot` instead)
- Packages that fail analysis (a warning is printed with the count)

Run with `--verbose` to see which packages were skipped and why.

## Performance

### Expected performance

| Package size | Extraction | Diff | Total |
|-------------|-----------|------|-------|
| 100 exports | ~100ms | ~1ms | ~200ms |
| 1,000 exports | ~300ms | ~1ms | ~500ms |
| 5,000 exports | ~400ms | ~2ms | ~600ms |

Add ~1-3 seconds for npm download (cached) or ~5-10 seconds (first download).

### High memory usage

Each `ts.createProgram()` call uses ~50-100MB. In `--workspaces` mode with many packages, memory can add up. If you hit OOM:

1. Use `--filter` to process workspace subsets
2. Increase Node's heap: `NODE_OPTIONS=--max-old-space-size=4096 typediff ...`
3. Run workspaces in parallel CI jobs instead of `--workspaces`

### Slow on first run

The first run downloads packages from npm. Subsequent runs use the cache at `$TMPDIR/typediff-cache/`. On CI, consider caching this directory between runs:

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: /tmp/typediff-cache
    key: typediff-cache-${{ hashFiles('package-lock.json') }}
```
