import { describe, expect, it } from 'vitest'
import { expiresText, moveInto, parentOf, previewKind, sortEntries } from './file-browser'

const file = (name: string, size?: number, modified?: string) => ({ name, path: name, type: 'file' as const, ...(size !== undefined ? { size } : {}), ...(modified ? { modified } : {}) })
const dir = (name: string) => ({ name, path: name, type: 'dir' as const })

describe('a file browser', () => {
  it('keeps folders first and sorts the rest by name, size or date, either way', () => {
    const entries = [file('b10.txt', 5, '2026-10-02'), dir('z'), file('b2.txt', 50, '2026-10-01'), file('a.txt', 1, '2026-10-03')]
    expect(sortEntries(entries, 'name').map((entry) => entry.name)).toEqual(['z', 'a.txt', 'b2.txt', 'b10.txt'])
    expect(sortEntries(entries, 'size', true).map((entry) => entry.name)).toEqual(['z', 'b2.txt', 'b10.txt', 'a.txt'])
    expect(sortEntries(entries, 'modified').map((entry) => entry.name)).toEqual(['z', 'b2.txt', 'b10.txt', 'a.txt'])
  })

  it('previews what a browser can show, by its name', () => {
    expect(['a.PNG', 'b.pdf', 'c.mp4', 'd.mp3', 'e.csv', 'f.docx', 'README'].map(previewKind)).toEqual(['image', 'pdf', 'video', 'audio', 'text', 'none', 'none'])
  })

  it('moves a file or folder into another folder, never into itself or where it already is', () => {
    expect(moveInto('docs/a.pdf', 'archive')).toBe('archive/a.pdf')
    expect(moveInto('docs/a.pdf', '')).toBe('a.pdf')
    expect(moveInto('docs/a.pdf', 'docs')).toBeUndefined()
    expect(moveInto('docs', 'docs/old')).toBeUndefined()
    expect(moveInto('docs', 'docs')).toBeUndefined()
    expect(parentOf('a/b/c.txt')).toBe('a/b')
  })

  it('says how long a link has left', () => {
    const now = new Date('2026-10-21T10:00:00Z')
    expect(expiresText('2026-10-21T15:00:00Z', now)).toBe('5 hours left')
    expect(expiresText('2026-10-28T10:00:00Z', now)).toBe('7 days left')
    expect(expiresText('2026-10-21T09:00:00Z', now)).toBe('expired')
  })
})
