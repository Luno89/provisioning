import { describe, expect, it } from 'vitest'
import { attachmentPath, droppedFiles, joinPath, pickedFiles, sentAttachment, sizeText } from './file-drop'

const file = (name: string, text = name) => new File([text], name)

const entry = (name: string, children?: unknown[]) => (children
  ? { isFile: false, isDirectory: true, name, createReader: () => { let given = false; return { readEntries: (done: (entries: unknown[]) => void) => { done(given ? [] : children); given = true } } } }
  : { isFile: true, isDirectory: false, name, file: (done: (f: File) => void) => done(file(name)) })

describe('what was dropped', () => {
  it('walks a dropped folder into every file in it, keeping where each sat', async () => {
    const items = [
      { kind: 'file', webkitGetAsEntry: () => entry('site', [entry('index.html'), entry('img', [entry('logo.png')])]) },
      { kind: 'file', webkitGetAsEntry: () => entry('notes.md') },
    ]
    const found = await droppedFiles({ items: items as never, files: [] as never })
    expect(found.map((one) => one.path)).toEqual(['site/index.html', 'site/img/logo.png', 'notes.md'])
  })

  it('takes plain files when the browser gives no entries', async () => {
    const found = await droppedFiles({ items: [] as never, files: [file('a.txt')] as never })
    expect(found.map((one) => one.path)).toEqual(['a.txt'])
    expect(pickedFiles([file('b.txt')]).map((one) => one.path)).toEqual(['b.txt'])
  })
})

describe('where things go', () => {
  it('joins paths and names an attachment by its chat, or by the day in a project', () => {
    expect(joinPath('/docs/', '', 'a.pdf')).toBe('docs/a.pdf')
    expect(attachmentPath(true, 'a/b.pdf', new Date('2026-10-21T10:03:09Z'))).toBe('attachments/2026-10-21/100309-a_b.pdf')
    expect(attachmentPath(false, 'x.png', new Date('2026-10-21T10:03:09Z'))).toBe('chats/2026-10-21/100309-x.png')
    expect(sentAttachment({ name: 'x.png', path: 'p', size: 3, project: { id: 'p1' } })).toEqual({ name: 'x.png', path: 'p', size: 3, projectId: 'p1' })
    expect([sizeText(500), sizeText(2048), sizeText(5 * 1024 ** 2), sizeText(undefined)]).toEqual(['500 B', '2.0 KB', '5.0 MB', ''])
  })
})
