import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  dropStoredFiles, listFileShares, listStoredFiles, makeStoredFolder, moveStoredFile, readStoredText,
  removeStoredFile, revokeFileShare, searchStoredFiles, shareStoredFile, shareUrl, storedRoom, uploadStoredFile,
} from './files'
import { attachmentPlace } from '../lib/file-drop'
import type { FileShare, StoredFile } from '../types'
import { startBackend } from '../../../test/backend/site'
import { storedFilesOnMinio } from '../../../test/backend/files'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { filesRouter, shareRouter } from '../../../../../backend/src/files/routes/files'
import { FileService } from '../../../../../backend/src/files/services/FileService'
import type { FileEntry } from '../../../../../backend/src/files/lib/file-places'
import type { FileShare as BackendFileShare } from '../../../../../backend/src/files/lib/file-shares'
import { authorize } from '../../../../../backend/src/platform/lib/permissions'

let free = 1024 ** 3

const backend = await startBackend(async ({ api, db }) => {
  const files = new FileService({ files: await storedFilesOnMinio(db, async () => free), shares: db.files })
  api.use('/files', filesRouter({
    files,
    getOwnedProject: async (id, principal) => {
      const project = (await db.projects.getProjects()).find((entry) => entry.id === id)
      return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined
    },
    getOwnedConversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
  }))
  api.use('/share', shareRouter({ files }))
})

const owner = await backend.signIn()
const now = new Date().toISOString()
await backend.db.projects.saveProjectInfo({ id: 'shop', name: 'Shop', ownerId: owner.id, createdAt: now } as never)
await backend.db.engine.saveConversation({ id: 'chat', ownerId: owner.id, title: 'A chat', messages: [], createdAt: now, updatedAt: now } as never)
await backend.db.engine.saveConversation({ id: 'shop-chat', ownerId: owner.id, title: 'About the shop', projectId: 'shop', messages: [], createdAt: now, updatedAt: now } as never)

expectTypeOf<Wire<FileEntry>>().toExtend<StoredFile>()
expectTypeOf<Wire<BackendFileShare>>().toExtend<FileShare>()

const shop = { kind: 'project' as const, projectId: 'shop' }

describe('a person\'s files on their instance, as the file browser asks for them', () => {
  it('keeps a project\'s files with nothing to choose first: uploads with its type and answers the stored file\'s id, lists, reads, searches, moves and removes', async () => {
    const stored = await uploadStoredFile(shop, 'docs/brief.md', new Blob(['# The brief'], { type: 'text/markdown' }))
    expect(stored).toEqual({ path: 'docs/brief.md', id: anyOf(String) })
    expect(await listStoredFiles(shop, '')).toEqual([objectWith({ name: 'docs', path: 'docs', type: 'dir' })])
    expect(await listStoredFiles(shop, 'docs')).toEqual([objectWith({ name: 'brief.md', path: 'docs/brief.md', type: 'file', size: 11 })])
    expect(await readStoredText(shop, 'docs/brief.md')).toBe('# The brief')
    expect(await searchStoredFiles(shop, 'brief')).toEqual([objectWith({ path: 'docs/brief.md' })])
    expect(await makeStoredFolder(shop, 'archive')).toEqual({ path: 'archive' })
    expect(await moveStoredFile(shop, 'docs/brief.md', 'archive/brief.md')).toEqual(objectWith({ path: 'archive/brief.md' }))
    expect(await listStoredFiles(shop, 'archive')).toEqual([objectWith({ path: 'archive/brief.md' })])
    await expect(readStoredText(shop, 'docs/brief.md')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(listStoredFiles(shop, '../escape')).rejects.toMatchObject({ response: { status: 400 } })
    expect(await removeStoredFile(shop, 'archive/brief.md')).toEqual(objectWith({ path: 'archive/brief.md' }))
    expect(await listStoredFiles(shop, 'archive')).toEqual([])
  })

  it('keeps the person\'s own files apart from their projects', async () => {
    expect(await uploadStoredFile({ kind: 'mine' }, 'notes.txt', new Blob(['mine'], { type: 'text/plain' }))).toEqual({ path: 'notes.txt', id: anyOf(String) })
    expect(await listStoredFiles({ kind: 'mine' }, '')).toEqual([objectWith({ path: 'notes.txt' })])
    expect((await listStoredFiles(shop, '')).map((entry) => entry.path)).not.toContain('notes.txt')
  })

  it('keeps what is attached in a chat where the composer puts it and the message finds it again', async () => {
    const alone = attachmentPlace('chat', undefined, 'a/b.txt')
    const inShop = attachmentPlace('shop-chat', 'shop', 'brief.txt')
    const aloneId = (await uploadStoredFile(alone.scope, alone.path, new Blob(['alone'], { type: 'text/plain' }))).id
    const shopId = (await uploadStoredFile(inShop.scope, inShop.path, new Blob(['in the shop'], { type: 'text/plain' }))).id
    expect(aloneId).not.toBe(shopId)
    expect(await listStoredFiles({ kind: 'conversation', conversationId: 'chat' }, '')).toEqual([objectWith({ path: 'a_b.txt' })])
    expect(await readStoredText({ kind: 'conversation', conversationId: 'chat' }, 'a_b.txt')).toBe('alone')
    expect(await listStoredFiles({ kind: 'conversation', conversationId: 'shop-chat' }, '')).toEqual([objectWith({ path: 'brief.txt' })])
    expect(await readStoredText(shop, 'chats/shop-chat/brief.txt')).toBe('in the shop')
    expect((await listStoredFiles({ kind: 'mine' }, '')).map((entry) => entry.path)).toEqual(['notes.txt'])
  })

  it('shares a file by a link that opens with no session, follows its new version, stops once it moves, and is revoked', async () => {
    await uploadStoredFile({ kind: 'mine' }, 'shared.txt', new Blob(['first'], { type: 'text/plain' }))
    const shared = await shareStoredFile({ kind: 'mine' }, 'shared.txt', 7)
    expect(shared).toEqual(objectWith({ id: anyOf(String), token: anyOf(String), ownerId: owner.id, path: 'shared.txt', name: 'shared.txt', expiresAt: anyOf(String) }))
    await expect(shareStoredFile({ kind: 'mine' }, 'shared.txt', 3 as 7)).rejects.toMatchObject({ response: { status: 400 } })
    expect(await listFileShares()).toEqual([objectWith({ id: shared.id, path: 'shared.txt' })])
    const opened = await fetch(shareUrl(shared.token, backend.origin))
    expect([opened.status, await opened.text()]).toEqual([200, 'first'])
    await uploadStoredFile({ kind: 'mine' }, 'shared.txt', new Blob(['second'], { type: 'text/plain' }), undefined, true)
    const again = await fetch(shareUrl(shared.token, backend.origin))
    expect([again.status, await again.text()]).toEqual([200, 'second'])
    await moveStoredFile({ kind: 'mine' }, 'shared.txt', 'moved.txt')
    expect((await fetch(shareUrl(shared.token, backend.origin))).status).toBe(404)

    await uploadStoredFile({ kind: 'mine' }, 'kept.txt', new Blob(['kept'], { type: 'text/plain' }))
    const kept = await shareStoredFile({ kind: 'mine' }, 'kept.txt', 1)
    expect(await revokeFileShare(kept.id)).toEqual({ id: kept.id })
    expect((await listFileShares()).map((share) => share.id)).not.toContain(kept.id)
    expect((await fetch(shareUrl(kept.token, backend.origin))).status).toBe(404)
  })
})

describe('adding files, as the file browser sends them', () => {
  const kept = { kind: 'project' as const, projectId: 'shop' }

  it('lists each file with its id, refuses a taken path unless told to replace it, and names the stored file the link follows', async () => {
    const first = await uploadStoredFile(kept, 'taken/report.pdf', new Blob(['one'], { type: 'application/pdf' }))
    expect(await listStoredFiles(kept, 'taken')).toEqual([objectWith({ path: 'taken/report.pdf', id: first.id })])
    await expect(uploadStoredFile(kept, 'taken/report.pdf', new Blob(['two']))).rejects.toMatchObject({ response: { status: 409, data: objectWith({ exists: true }) } })
    expect(await readStoredText(kept, 'taken/report.pdf')).toBe('one')
    expect(await uploadStoredFile(kept, 'taken/report.pdf', new Blob(['two']), undefined, true)).toEqual({ path: 'taken/report.pdf', id: first.id })
    expect(await readStoredText(kept, 'taken/report.pdf')).toBe('two')
    const link = await shareStoredFile(kept, 'taken/report.pdf', 1)
    expect((await listFileShares()).find((share) => share.id === link.id)).toEqual(objectWith({ fileId: first.id }))
  })

  it('keeps a batch in one drop, refuses the whole batch when a path is taken, and replaces when told to', async () => {
    const files = [{ path: 'a.txt', file: new File(['a'], 'a.txt') }, { path: 'deep/b.txt', file: new File(['bb'], 'b.txt') }]
    const dropped = await dropStoredFiles(kept, 'batch', files, false)
    expect(dropped.files).toEqual([{ path: 'batch/a.txt', id: anyOf(String) }, { path: 'batch/deep/b.txt', id: anyOf(String) }])
    expect(await readStoredText(kept, 'batch/deep/b.txt')).toBe('bb')
    const again = [{ path: 'a.txt', file: new File(['A'], 'a.txt') }, { path: 'c.txt', file: new File(['c'], 'c.txt') }]
    await expect(dropStoredFiles(kept, 'batch', again, false)).rejects.toMatchObject({ response: { status: 409, data: objectWith({ exists: ['batch/a.txt'] }) } })
    expect((await listStoredFiles(kept, 'batch')).map((entry) => entry.path)).not.toContain('batch/c.txt')
    await dropStoredFiles(kept, 'batch', again, true)
    expect(await readStoredText(kept, 'batch/a.txt')).toBe('A')
  })

  it('says how much room is left, and refuses what would not fit', async () => {
    free = 4
    try {
      expect(await storedRoom()).toEqual({ free: 4 })
      await expect(uploadStoredFile(kept, 'full/big.bin', new Blob(['too big']))).rejects.toMatchObject({ response: { status: 507, data: objectWith({ needed: anyOf(Number), free: 4 }) } })
      await expect(dropStoredFiles(kept, 'full', [{ path: 'x', file: new File(['xx'], 'x') }, { path: 'y', file: new File(['yyy'], 'y') }], false)).rejects.toMatchObject({ response: { status: 507 } })
      expect((await listStoredFiles(kept, '')).map((entry) => entry.path)).not.toContain('full')
    } finally {
      free = 1024 ** 3
    }
  })
})

describe('another person\'s files, as the file browser asks for them', () => {
  it('reaches none of the first person\'s projects, chats or links', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(listStoredFiles(shop, '')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(listStoredFiles({ kind: 'conversation', conversationId: 'chat' }, '')).rejects.toMatchObject({ response: { status: 404 } })
    expect(await listStoredFiles({ kind: 'mine' }, '')).toEqual([])
    expect(await listFileShares()).toEqual([])
  })
})
