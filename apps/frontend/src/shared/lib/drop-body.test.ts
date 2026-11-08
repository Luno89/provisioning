import { describe, expect, it } from 'vitest'
import { dropBody } from './drop-body'

describe('the drop the browser sends', () => {
  it('is the settings, then each file named with its size in bytes and its bytes as they are', async () => {
    const png = new Uint8Array([0x89, 0x0a, 0x00, 0xff])
    const body = dropBody({ dir: 'public', leafId: 'l1' }, [{ path: 'logo.png', file: new Blob([png]) }, { path: 'é.md', file: new Blob(['é']) }])
    const bytes = new Uint8Array(await body.arrayBuffer())
    const head = new TextEncoder().encode('{"dir":"public","leafId":"l1"}\n{"path":"logo.png","size":4}\n')
    expect(Array.from(bytes.subarray(0, head.length))).toEqual(Array.from(head))
    expect(Array.from(bytes.subarray(head.length, head.length + 4))).toEqual(Array.from(png))
    expect(new TextDecoder().decode(bytes.subarray(head.length + 4))).toBe('{"path":"é.md","size":2}\né')
  })
})
