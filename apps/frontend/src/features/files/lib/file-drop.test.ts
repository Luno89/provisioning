import { describe, expect, it } from 'vitest'
import { attachmentName, attachmentPlace, numberedName, droppedFiles, joinPath, pickedFiles, sentAttachment, sentAttachmentPlace, sizeText } from './file-drop'

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
  it('joins paths and says sizes', () => {
    expect(joinPath('/docs/', '', 'a.pdf')).toBe('docs/a.pdf')
    expect([sizeText(500), sizeText(2048), sizeText(5 * 1024 ** 2), sizeText(3 * 1024 ** 3), sizeText(undefined)]).toEqual(['500 B', '2.0 KB', '5.0 MB', '3.00 GB', ''])
  })
})

describe('an attachment\'s name', () => {
  it('keeps a plain name and turns every slash into an underscore', () => {
    expect(attachmentName('brief.pdf')).toBe('brief.pdf')
    expect(attachmentName('a/b\\c.pdf')).toBe('a_b_c.pdf')
    expect(attachmentName('  spaced.txt ')).toBe('spaced.txt')
  })

  it('never names a folder above or the folder itself', () => {
    expect(['', ' ', '.', '..'].map(attachmentName)).toEqual(['file', 'file', 'file', 'file'])
    expect(attachmentName('../x')).toBe('.._x')
  })

  it('names the same file again however often it is cleaned', () => {
    for (const name of ['a/b.pdf', '..', 'x\\y', 'plain']) expect(attachmentName(attachmentName(name))).toBe(attachmentName(name))
  })
})

describe('where an attachment is kept', () => {
  it('is the project\'s chats folder for the conversation when the chat has a project', () => {
    expect(attachmentPlace('c1', 'p1', 'a/b.pdf')).toEqual({ scope: { kind: 'project', projectId: 'p1' }, path: 'chats/c1/a_b.pdf' })
  })

  it('is the chat\'s own files when it has none', () => {
    expect(attachmentPlace('c1', undefined, 'x.png')).toEqual({ scope: { kind: 'conversation', conversationId: 'c1' }, path: 'x.png' })
  })

  it('is found again from a sent message by its chat, and not for one from before files had ids', () => {
    expect(sentAttachmentPlace({ fileId: 'f1', name: 'brief.pdf', project: { id: 'p1', name: 'Shop' } }, 'c1')).toEqual({ scope: { kind: 'project', projectId: 'p1' }, path: 'chats/c1/brief.pdf' })
    expect(sentAttachmentPlace({ fileId: 'f1', name: 'x.png' }, 'c1')).toEqual({ scope: { kind: 'conversation', conversationId: 'c1' }, path: 'x.png' })
    expect(sentAttachmentPlace({ name: 'old.png' }, 'c1')).toBeUndefined()
    expect(sentAttachmentPlace({ fileId: 'f1', name: 'x.png' }, undefined)).toBeUndefined()
  })

  it('is the shared project\'s files on the hub, where a chat\'s own files cannot be reached', () => {
    expect(sentAttachmentPlace({ fileId: 'f1', name: 'brief.pdf', project: { id: 'p1', name: 'Shop' } }, 'c1', 'h1')).toEqual({ scope: { kind: 'hub', projectId: 'h1' }, path: 'chats/c1/brief.pdf' })
    expect(sentAttachmentPlace({ fileId: 'f2', name: 'x.png' }, 'c1', 'h1')).toBeUndefined()
    expect(sentAttachmentPlace({ name: 'old.png', project: { id: 'p1', name: 'Shop' } }, 'c1', 'h1')).toBeUndefined()
  })
})

describe('what is sent of an attachment', () => {
  it('is its file\'s id with its name, size, type and project', () => {
    expect(sentAttachment({ fileId: 'f1', name: 'x.png', size: 3, type: 'image/png', project: { id: 'p1', name: 'Shop' } })).toEqual([{ fileId: 'f1', name: 'x.png', size: 3, type: 'image/png', projectId: 'p1' }])
    expect(sentAttachment({ fileId: 'f2', name: 'y.txt', size: 0 })).toEqual([{ fileId: 'f2', name: 'y.txt', size: 0 }])
  })

  it('is nothing for one that has no id', () => {
    expect(sentAttachment({ name: 'old.png', path: 'chats/2026-10-21/old.png' })).toEqual([])
  })
})

describe('the name an attachment takes when its name is already in the chat', () => {
  it('keeps the name the first time, then numbers it before its extension', () => {
    expect(numberedName('photo.png', 1)).toBe('photo.png')
    expect(numberedName('photo.png', 0)).toBe('photo.png')
    expect(numberedName('photo.png', 2)).toBe('photo (2).png')
    expect(numberedName('archive.tar.gz', 3)).toBe('archive.tar (3).gz')
  })

  it('numbers a name with no extension, or one that only starts with a dot, at its end', () => {
    expect(numberedName('README', 2)).toBe('README (2)')
    expect(numberedName('.env', 2)).toBe('.env (2)')
  })

  it('puts the numbered name in the chat\'s place', () => {
    expect(attachmentPlace('c1', undefined, 'photo.png', 2)).toEqual({ scope: { kind: 'conversation', conversationId: 'c1' }, path: 'photo (2).png' })
    expect(attachmentPlace('c1', 'p1', 'photo.png', 2)).toEqual({ scope: { kind: 'project', projectId: 'p1' }, path: 'chats/c1/photo (2).png' })
  })
})
