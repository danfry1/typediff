import { describe, it, expect } from 'vitest'
import { parseLockfileDiff, detectLockfileType } from '../lockfile.js'

describe('detectLockfileType', () => {
  it('detects npm lockfile', () => {
    expect(detectLockfileType('package-lock.json')).toBe('npm')
  })

  it('detects yarn lockfile', () => {
    expect(detectLockfileType('yarn.lock')).toBe('yarn')
  })

  it('detects pnpm lockfile', () => {
    expect(detectLockfileType('pnpm-lock.yaml')).toBe('pnpm')
  })

  it('detects bun lockfile', () => {
    expect(detectLockfileType('bun.lock')).toBe('bun')
    expect(detectLockfileType('bun.lockb')).toBe('bun')
  })

  it('returns null for unknown files', () => {
    expect(detectLockfileType('package.json')).toBe(null)
    expect(detectLockfileType('tsconfig.json')).toBe(null)
    expect(detectLockfileType('foo.txt')).toBe(null)
  })
})

describe('parseLockfileDiff', () => {
  it('returns empty array for empty diff', () => {
    expect(parseLockfileDiff('', 'npm')).toEqual([])
  })

  it('extracts changed packages from npm lockfile diff', () => {
    const diff = `
diff --git a/package-lock.json b/package-lock.json
index abc1234..def5678 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -100,7 +100,7 @@
     "node_modules/typescript": {
-      "version": "5.3.3",
+      "version": "5.4.2",
       "resolved": "https://registry.npmjs.org/typescript/-/typescript-5.4.2.tgz",
       "integrity": "sha512-abc123",
       "dev": true,
@@ -200,7 +200,7 @@
     "node_modules/zod": {
-      "version": "3.22.0",
+      "version": "3.22.4",
       "resolved": "https://registry.npmjs.org/zod/-/zod-3.22.4.tgz",
       "integrity": "sha512-def456",
`
    const result = parseLockfileDiff(diff, 'npm')
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
      { name: 'zod', oldVersion: '3.22.0', newVersion: '3.22.4' },
    ])
  })

  it('handles scoped packages', () => {
    const diff = `
diff --git a/package-lock.json b/package-lock.json
@@ -50,7 +50,7 @@
     "node_modules/@tanstack/react-query": {
-      "version": "5.17.0",
+      "version": "5.18.1",
       "resolved": "https://registry.npmjs.org/@tanstack/react-query/-/react-query-5.18.1.tgz",
@@ -80,7 +80,7 @@
     "node_modules/@types/node": {
-      "version": "20.10.0",
+      "version": "20.11.5",
       "resolved": "https://registry.npmjs.org/@types/node/-/node-20.11.5.tgz",
`
    const result = parseLockfileDiff(diff, 'npm')
    expect(result).toEqual([
      { name: '@tanstack/react-query', oldVersion: '5.17.0', newVersion: '5.18.1' },
      { name: '@types/node', oldVersion: '20.10.0', newVersion: '20.11.5' },
    ])
  })

  it('handles nested node_modules entries', () => {
    const diff = `
diff --git a/package-lock.json b/package-lock.json
@@ -100,7 +100,7 @@
     "node_modules/parent-pkg/node_modules/nested-dep": {
-      "version": "1.0.0",
+      "version": "1.1.0",
       "resolved": "https://registry.npmjs.org/nested-dep/-/nested-dep-1.1.0.tgz",
`
    const result = parseLockfileDiff(diff, 'npm')
    expect(result).toEqual([
      { name: 'nested-dep', oldVersion: '1.0.0', newVersion: '1.1.0' },
    ])
  })

  it('skips workspace packages with file: resolved', () => {
    const diff = `
diff --git a/package-lock.json b/package-lock.json
@@ -10,7 +10,7 @@
     "node_modules/my-local-pkg": {
-      "version": "1.0.0",
+      "version": "1.1.0",
       "resolved": "file:packages/my-local-pkg",
@@ -50,7 +50,7 @@
     "node_modules/real-pkg": {
-      "version": "2.0.0",
+      "version": "2.1.0",
       "resolved": "https://registry.npmjs.org/real-pkg/-/real-pkg-2.1.0.tgz",
`
    const result = parseLockfileDiff(diff, 'npm')
    expect(result).toEqual([
      { name: 'real-pkg', oldVersion: '2.0.0', newVersion: '2.1.0' },
    ])
  })

  it('skips workspace packages with workspace: resolved', () => {
    const diff = `
diff --git a/package-lock.json b/package-lock.json
@@ -10,7 +10,7 @@
     "node_modules/my-workspace-pkg": {
-      "version": "1.0.0",
+      "version": "1.1.0",
       "resolved": "workspace:packages/my-workspace-pkg",
@@ -50,7 +50,7 @@
     "node_modules/external-pkg": {
-      "version": "3.0.0",
+      "version": "3.0.1",
       "resolved": "https://registry.npmjs.org/external-pkg/-/external-pkg-3.0.1.tgz",
`
    const result = parseLockfileDiff(diff, 'npm')
    expect(result).toEqual([
      { name: 'external-pkg', oldVersion: '3.0.0', newVersion: '3.0.1' },
    ])
  })

  it('handles yarn lockfile diff', () => {
    const diff = `
diff --git a/yarn.lock b/yarn.lock
@@ -100,4 +100,4 @@
-typescript@^5.3.0:
-  version "5.3.3"
-  resolved "https://registry.yarnpkg.com/typescript/-/typescript-5.3.3.tgz"
-  integrity sha512-abc
+typescript@^5.3.0:
+  version "5.4.2"
+  resolved "https://registry.yarnpkg.com/typescript/-/typescript-5.4.2.tgz"
+  integrity sha512-def
`
    const result = parseLockfileDiff(diff, 'yarn')
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
    ])
  })

  it('handles yarn berry (v2+) lockfile diff', () => {
    const diff = `
diff --git a/yarn.lock b/yarn.lock
@@ -100,4 +100,4 @@
-"typescript@npm:^5.3.0":
-  version: 5.3.3
-  resolution: "typescript@npm:5.3.3"
+"typescript@npm:^5.4.0":
+  version: 5.4.2
+  resolution: "typescript@npm:5.4.2"
`
    const result = parseLockfileDiff(diff, 'yarn')
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
    ])
  })

  it('handles pnpm lockfile diff', () => {
    const diff = `
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -50,3 +50,3 @@
-  /typescript@5.3.3:
+  /typescript@5.4.2:
     resolution: {integrity: sha512-abc}
@@ -80,3 +80,3 @@
-  /zod@3.22.0:
+  /zod@3.22.4:
     resolution: {integrity: sha512-def}
`
    const result = parseLockfileDiff(diff, 'pnpm')
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
      { name: 'zod', oldVersion: '3.22.0', newVersion: '3.22.4' },
    ])
  })

  it('handles pnpm v9 lockfile diff (no leading slash)', () => {
    const diff = `
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -50,3 +50,3 @@
-  typescript@5.3.3:
+  typescript@5.4.2:
     resolution: {integrity: sha512-abc}
@@ -80,3 +80,3 @@
-  zod@3.22.0:
+  zod@3.22.4:
     resolution: {integrity: sha512-def}
`
    const result = parseLockfileDiff(diff, 'pnpm')
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
      { name: 'zod', oldVersion: '3.22.0', newVersion: '3.22.4' },
    ])
  })

  it('handles pnpm diff with packages split across git hunks', () => {
    const diff = `
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -50,3 +50,3 @@
-  /typescript@5.3.3:
+  /typescript@5.4.2:
     resolution: {integrity: sha512-abc}
@@ -200,3 +200,3 @@
-  /zod@3.22.0:
+  /zod@3.22.4:
     resolution: {integrity: sha512-def}
`
    const result = parseLockfileDiff(diff, 'pnpm')
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
      { name: 'zod', oldVersion: '3.22.0', newVersion: '3.22.4' },
    ])
  })

  it('does not pair pnpm entries across hunks incorrectly', () => {
    const diff = `
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -50,3 +50,3 @@
-  /pkg-a@1.0.0:
     resolution: {integrity: sha512-abc}
@@ -200,3 +200,3 @@
+  /pkg-b@2.0.0:
     resolution: {integrity: sha512-def}
`
    const result = parseLockfileDiff(diff, 'pnpm')
    // pkg-a was removed and pkg-b was added — they should NOT be paired as a version change
    expect(result).toEqual([])
  })

  it('skips pnpm workspace/link packages', () => {
    const diff = `
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -50,3 +50,3 @@
-  /my-local-pkg@link:../packages/my-pkg:
+  /my-local-pkg@link:../packages/my-pkg-v2:
     resolution: {directory: packages/my-pkg}
@@ -80,3 +80,3 @@
-  /typescript@5.3.3:
+  /typescript@5.4.2:
     resolution: {integrity: sha512-abc}
`
    const result = parseLockfileDiff(diff, 'pnpm')
    // Workspace link package should be skipped, only real npm packages included
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
    ])
  })

  it('skips pnpm file: and workspace: versions', () => {
    const diff = `
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -50,3 +50,3 @@
-  my-lib@file:../lib:
+  my-lib@file:../lib-v2:
@@ -60,3 +60,3 @@
-  shared@workspace:*:
+  shared@workspace:^1.0.0:
`
    const result = parseLockfileDiff(diff, 'pnpm')
    expect(result).toEqual([])
  })

  it('strips pnpm peer-dependency suffixes from versions', () => {
    const diff = `
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -50,3 +50,3 @@
-  @tanstack/react-query@5.17.0(react@18.2.0):
+  @tanstack/react-query@5.18.1(react@18.2.0):
`
    const result = parseLockfileDiff(diff, 'pnpm')
    expect(result).toEqual([
      { name: '@tanstack/react-query', oldVersion: '5.17.0', newVersion: '5.18.1' },
    ])
  })

  it('skips yarn workspace entries', () => {
    const diff = `
diff --git a/yarn.lock b/yarn.lock
@@ -1,5 +1,5 @@
-"my-workspace-pkg@workspace:packages/my-pkg":
-  version "1.0.0"
+"my-workspace-pkg@workspace:packages/my-pkg":
+  version "1.0.1"
`
    const result = parseLockfileDiff(diff, 'yarn')
    expect(result).toEqual([])
  })

  it('skips bun workspace entries', () => {
    const diff = `
diff --git a/bun.lock b/bun.lock
@@ -10,7 +10,7 @@
-    "my-local-pkg": ["my-local-pkg@workspace:packages/my-pkg", "", {}],
+    "my-local-pkg": ["my-local-pkg@workspace:packages/my-pkg", "", {}],
`
    const result = parseLockfileDiff(diff, 'bun')
    expect(result).toEqual([])
  })

  it('handles bun lockfile diff', () => {
    const diff = `
diff --git a/bun.lock b/bun.lock
@@ -10,7 +10,7 @@
-    "typescript": ["typescript@5.3.3", "", {}, "sha512-abc"],
+    "typescript": ["typescript@5.4.2", "", {}, "sha512-def"],
@@ -20,7 +20,7 @@
-    "zod": ["zod@3.22.0", "", {}, "sha512-ghi"],
+    "zod": ["zod@3.22.4", "", {}, "sha512-jkl"],
`
    const result = parseLockfileDiff(diff, 'bun')
    expect(result).toEqual([
      { name: 'typescript', oldVersion: '5.3.3', newVersion: '5.4.2' },
      { name: 'zod', oldVersion: '3.22.0', newVersion: '3.22.4' },
    ])
  })

  it('handles scoped packages in bun lockfile diff', () => {
    const diff = `
diff --git a/bun.lock b/bun.lock
@@ -10,7 +10,7 @@
-    "@tanstack/react-query": ["@tanstack/react-query@5.17.0", "", {}, "sha512-abc"],
+    "@tanstack/react-query": ["@tanstack/react-query@5.18.1", "", {}, "sha512-def"],
`
    const result = parseLockfileDiff(diff, 'bun')
    expect(result).toEqual([
      { name: '@tanstack/react-query', oldVersion: '5.17.0', newVersion: '5.18.1' },
    ])
  })
})
