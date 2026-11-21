import { describe, expect, it, vi } from 'vitest'
import type { StoredFile } from '../types'
import {
  fileIdsUnder, fits, linksStopped, movePrompt, replacePrompt, roomText,
  takenPaths, targetPaths, totalSize, uploadRefusal, uploadWay,
} from './file-upload'

const file = (path: string, id?: string, size = 1): StoredFile => ({ name: path.split('/').pop()!, path, type: 'file', size, ...(id ? { id } : {}) })
const dir = (path: string): StoredFile => ({ name: path.split('/').pop()!, path, type: 'dir' })

const folders = (tree: Record<string, StoredFile[]>) => vi.fn(async (at: string) => tree[at] ?? [])

const picked = (path: string, bytes: number) => ({ path, file: new File([new Uint8Array(bytes)], path.split('/').pop()!) })

describe('what an upload sends', () => {
  it('puts each picked file under the folder it was dropped on', () => {
    expect(targetPaths({ dir: 'docs', picked: [picked('a.txt', 1), picked('x/b.txt', 1)] })).toEqual(['docs/a.txt', 'docs/x/b.txt'])
    expect(targetPaths({ dir: '', picked: [picked('a.txt', 1)] })).toEqual(['a.txt'])
    expect(targetPaths({ dir: 'docs', picked: [] })).toEqual([])
  })

  it('adds up the bytes of everything picked', () => {
    expect(totalSize([])).toBe(0)
    expect(totalSize([picked('a', 3), picked('b', 1024)])).toBe(1027)
  })

  it('sends one file by itself and several as one drop', () => {
    expect(uploadWay(1)).toBe('put')
    expect(uploadWay(0)).toBe('put')
    expect(uploadWay(2)).toBe('drop')
    expect(uploadWay(5)).toBe('drop')
  })
})

describe('which uploads would replace a file', () => {
  it('finds files already at the paths, in the order they were picked, listing only folders that exist', async () => {
    const list = folders({
      '': [file('a.txt'), dir('docs'), dir('other')],
      docs: [file('docs/b.txt'), dir('docs/deep')],
      'docs/deep': [file('docs/deep/c.txt')],
    })
    expect(await takenPaths(list, ['docs/deep/c.txt', 'new.txt', 'a.txt', 'docs/b.txt', 'gone/x.txt'])).toEqual(['docs/deep/c.txt', 'a.txt', 'docs/b.txt'])
    expect(list.mock.calls.map((call) => call[0]).sort()).toEqual(['', 'docs', 'docs/deep'])
  })

  it('takes a folder of the same name for no file, and asks nothing for nothing', async () => {
    const list = folders({ '': [dir('a.txt')] })
    expect(await takenPaths(list, ['a.txt'])).toEqual([])
    const none = folders({})
    expect(await takenPaths(none, [])).toEqual([])
    expect(none).not.toHaveBeenCalled()
  })
})

describe('which share links a move stops', () => {
  const list = folders({
    '': [file('a.txt', 'A'), dir('docs'), file('noid.txt')],
    docs: [file('docs/b.txt', 'B'), dir('docs/deep')],
    'docs/deep': [file('docs/deep/c.txt', 'C')],
  })

  it('takes a file\'s own id and every file under a folder', async () => {
    expect((await fileIdsUnder(list, ['a.txt'])).sort()).toEqual(['A'])
    expect((await fileIdsUnder(list, ['docs'])).sort()).toEqual(['B', 'C'])
    expect((await fileIdsUnder(list, ['a.txt', 'docs/deep', 'noid.txt'])).sort()).toEqual(['A', 'C'])
    expect(await fileIdsUnder(list, ['missing.txt'])).toEqual([])
  })

  it('counts the links on those files, and the files they open', () => {
    const shares = [{ fileId: 'A' }, { fileId: 'A' }, { fileId: 'B' }, {}, { fileId: 'Z' }]
    expect(linksStopped(shares, ['A', 'B'])).toEqual({ links: 3, files: 2 })
    expect(linksStopped(shares, ['A'])).toEqual({ links: 2, files: 1 })
    expect(linksStopped(shares, [])).toEqual({ links: 0, files: 0 })
    expect(linksStopped([], ['A'])).toEqual({ links: 0, files: 0 })
  })

  it('says it in plain words', () => {
    expect(movePrompt({ links: 2, files: 1 }, false)).toBe('Moving this stops 2 share links; whoever has them can no longer open the file.')
    expect(movePrompt({ links: 1, files: 1 }, false)).toBe('Moving this stops 1 share link; whoever has it can no longer open the file.')
    expect(movePrompt({ links: 3, files: 2 }, true)).toBe('Moving these stops 3 share links; whoever has them can no longer open the files.')
  })
})

describe('what the person is told', () => {
  it('names what would be replaced, one dialog for several', () => {
    expect(replacePrompt(['report.pdf'])).toBe('Replace report.pdf? The file there now is replaced and can\'t be brought back.')
    expect(replacePrompt(['a', 'b'])).toBe('Replace a and b? The files there now are replaced and can\'t be brought back.')
    expect(replacePrompt(['a', 'b', 'c', 'd'])).toBe('Replace a, b, c and d? The files there now are replaced and can\'t be brought back.')
    expect(replacePrompt(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('Replace a, b, c and 3 more? The files there now are replaced and can\'t be brought back.')
  })

  it('says how much is needed and how much is free', () => {
    expect(fits(10, 10)).toBe(true)
    expect(fits(11, 10)).toBe(false)
    expect(roomText(3 * 1024 ** 3, 512 * 1024 ** 2)).toBe('This needs 3.00 GB and only 512.0 MB is free, so nothing was uploaded.')
    expect(roomText(10, 0)).toBe('This needs 10 B and only 0 B is free, so nothing was uploaded.')
  })
})

describe('what the server refused', () => {
  it('reads a taken path, naming the paths it gave or else what was sent', () => {
    expect(uploadRefusal(409, { error: 'x', exists: ['a', 'b', 3] }, ['a', 'b', 'c'])).toEqual({ kind: 'taken', paths: ['a', 'b'] })
    expect(uploadRefusal(409, { error: 'x', exists: true }, ['a.txt'])).toEqual({ kind: 'taken', paths: ['a.txt'] })
    expect(uploadRefusal(409, { error: 'another conflict' }, ['a.txt'])).toBeUndefined()
  })

  it('reads a lack of room with its numbers', () => {
    expect(uploadRefusal(507, { error: 'x', needed: 20, free: 5 }, [])).toEqual({ kind: 'room', needed: 20, free: 5 })
    expect(uploadRefusal(507, { error: 'x' }, [])).toBeUndefined()
    expect(uploadRefusal(507, { needed: 'lots', free: 5 }, [])).toBeUndefined()
  })

  it('reads nothing else', () => {
    expect(uploadRefusal(500, { exists: ['a'] }, ['a'])).toBeUndefined()
    expect(uploadRefusal(undefined, undefined, [])).toBeUndefined()
    expect(uploadRefusal(409, 'text', ['a'])).toEqual(undefined)
  })
})
