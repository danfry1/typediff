import { describe, it, expect } from 'vitest'
import type { ApiNode } from '../core/types.js'

describe('smoke test', () => {
  it('should import types without error', () => {
    const node: ApiNode = {
      name: 'test',
      path: 'test',
      kind: 'const',
      signature: 'string',
      children: [],
      typeId: 'abc',
      position: 'output',
      modifiers: {},
    }
    expect(node.name).toBe('test')
  })
})
