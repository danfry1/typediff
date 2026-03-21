import { readFileSync } from 'node:fs'

export function getVersion(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
