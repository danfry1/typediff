import { describe, it, expect, afterEach } from 'vitest'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tarballHasUnsafeEntries, readBodyWithLimit } from '../resolver/npm.js'
import { resolveLocal, NoTypesError } from '../resolver/local.js'

// ── Tarball construction helpers ────────────────────────────────────────────
// Minimal ustar headers — our scanner reads name/size/type and does not verify
// the checksum, so these are sufficient to exercise it.

const BLOCK = 512

function tarHeader(name: string, typeFlag: number, size = 0): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write(name, 0, 'utf-8')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii') // size (octal)
  h[156] = typeFlag
  return h
}

function makeTarGz(entries: Array<{ name: string; type: number; data?: Buffer }>): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0)
    blocks.push(tarHeader(e.name, e.type, data.length))
    if (data.length > 0) {
      const padded = Math.ceil(data.length / BLOCK) * BLOCK
      const buf = Buffer.alloc(padded)
      data.copy(buf)
      blocks.push(buf)
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2)) // end-of-archive
  return gzipSync(Buffer.concat(blocks))
}

const FILE = 48          // '0'
const DIR = 53           // '5'
const SYMLINK = 50       // '2'
const HARDLINK = 49      // '1'
const GNU_LONGNAME = 76  // 'L'
const PAX_EXTENDED = 120 // 'x'

describe('tarballHasUnsafeEntries', () => {
  it('accepts a tarball of plain files and directories', () => {
    const tar = makeTarGz([
      { name: 'package/', type: DIR },
      { name: 'package/package.json', type: FILE, data: Buffer.from('{}') },
      { name: 'package/index.d.ts', type: FILE, data: Buffer.from('export {}') },
    ])
    expect(tarballHasUnsafeEntries(tar)).toBe(false)
  })

  it('flags a tarball containing a symlink entry (zip-slip via symlink)', () => {
    const tar = makeTarGz([
      { name: 'package/link', type: SYMLINK },
      { name: 'package/link/payload', type: FILE, data: Buffer.from('x') },
    ])
    expect(tarballHasUnsafeEntries(tar)).toBe(true)
  })

  it('flags a tarball containing a hardlink entry', () => {
    const tar = makeTarGz([{ name: 'package/h', type: HARDLINK }])
    expect(tarballHasUnsafeEntries(tar)).toBe(true)
  })

  it('flags an entry that escapes via a `..` path segment', () => {
    const tar = makeTarGz([{ name: 'package/../../evil', type: FILE, data: Buffer.from('x') }])
    expect(tarballHasUnsafeEntries(tar)).toBe(true)
  })

  it('flags an entry with an absolute path', () => {
    const tar = makeTarGz([{ name: '/etc/passwd', type: FILE, data: Buffer.from('x') }])
    expect(tarballHasUnsafeEntries(tar)).toBe(true)
  })

  it('returns false for non-gzip / corrupt input (handled downstream)', () => {
    expect(tarballHasUnsafeEntries(Buffer.from('not a gzip'))).toBe(false)
  })

  // GNU long-name and PAX entries carry the real path of the *next* entry in
  // their data block, which the header scan does not read. They must be treated
  // as unsafe so the tarball is routed to the JS fallback, never to system tar —
  // otherwise the embedded `../escape` path is a zip-slip bypass.
  it('flags a GNU long-name (L) entry even with an innocuous header name', () => {
    const tar = makeTarGz([
      { name: '././@LongLink', type: GNU_LONGNAME, data: Buffer.from('../../evil.sh\0') },
      { name: 'package/innocent', type: FILE, data: Buffer.from('x') },
    ])
    expect(tarballHasUnsafeEntries(tar)).toBe(true)
  })

  it('flags a PAX extended (x) entry even with an innocuous header name', () => {
    const tar = makeTarGz([
      { name: 'package/pax_header', type: PAX_EXTENDED, data: Buffer.from('30 path=../../evil.sh\n') },
      { name: 'package/innocent', type: FILE, data: Buffer.from('x') },
    ])
    expect(tarballHasUnsafeEntries(tar)).toBe(true)
  })
})

describe('readBodyWithLimit', () => {
  it('rejects when Content-Length exceeds the cap', async () => {
    const res = new Response('x', { headers: { 'content-length': String(10 * 1024) } })
    await expect(readBodyWithLimit(res, 1024)).rejects.toThrow(/maximum allowed size/)
  })

  it('rejects when the streamed body exceeds the cap (no Content-Length)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(800))
        controller.enqueue(new Uint8Array(800))
        controller.close()
      },
    })
    const res = new Response(stream)
    await expect(readBodyWithLimit(res, 1024)).rejects.toThrow(/maximum allowed size/)
  })

  it('returns the full buffer for a body within the cap', async () => {
    const res = new Response('hello')
    const buf = await readBodyWithLimit(res, 1024)
    expect(buf.toString('utf-8')).toBe('hello')
  })
})

describe('NoTypesError', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('resolveLocal throws NoTypesError when a package ships no type definitions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typediff-notypes-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-types', version: '1.0.0' }))

    expect(() => resolveLocal(dir)).toThrow(NoTypesError)
  })

  it('lets a corrupt package.json surface as a real error, not a missing-types one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typediff-corrupt-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{ this is not valid json')

    // A JSON parse failure is operational — it must NOT be reported as NoTypesError,
    // so the @types fallback is not triggered and the real cause is preserved.
    let caught: unknown
    try {
      resolveLocal(dir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(NoTypesError)
  })
})
