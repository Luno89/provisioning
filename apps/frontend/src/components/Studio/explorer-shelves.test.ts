import { describe, expect, it } from 'vitest'
import type { ExplorerGroup } from './Explorer'
import { shelvesOf } from './explorer-shelves'

const group = (id: string, folder?: string): ExplorerGroup => ({ id, title: id, items: [], ...(folder ? { folder } : {}) })

describe('folders in an explorer', () => {
  it('puts groups that share a folder under it, in order, and leaves the rest on their own', () => {
    const shelves = shelvesOf([group('a', 'Tools'), group('b', 'Tools'), group('c', 'MCP Servers'), group('d')])
    expect(shelves.map((shelf) => [shelf.folder, shelf.groups.map((one) => one.id)])).toEqual([['Tools', ['a', 'b']], ['MCP Servers', ['c']], [undefined, ['d']]])
  })
})
