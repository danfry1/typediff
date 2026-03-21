export function parseSpec(spec: string): { name: string; version: string } | null {
  // Check for scoped package: @scope/name@version
  if (spec.startsWith('@')) {
    const idx = spec.indexOf('@', 1)
    if (idx === -1) return null
    const name = spec.slice(0, idx)
    const version = spec.slice(idx + 1)
    if (!name || !version) return null
    return { name, version }
  }
  // Unscoped: name@version
  const idx = spec.lastIndexOf('@')
  if (idx <= 0) return null
  const name = spec.slice(0, idx)
  const version = spec.slice(idx + 1)
  if (!name || !version) return null
  return { name, version }
}

export function isLocalPath(spec: string): boolean {
  if (spec === '.' || spec === '..') return true
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
    || spec.startsWith('.\\') || spec.startsWith('..\\')
    || /^[a-zA-Z]:[\\/]/.test(spec)  // Windows drive paths: C:\...
    || spec.startsWith('\\\\')        // Windows UNC paths: \\server\share
}
