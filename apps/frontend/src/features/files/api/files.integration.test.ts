import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  chooseFileServer, getFilePlace, getFileServers, listFileShares, listStoredFiles, makeStoredFolder, moveStoredFile, readStoredText,
  removeStoredFile, revokeFileShare, searchStoredFiles, setDefaultFileServer, shareStoredFile, shareUrl, startProjectMinio, uploadStoredFile,
} from './files'
import { getArtifactStorage } from './artifacts'
import type { FileServer, FileShare, PlaceState, StoredFile } from '../types'
import { startBackend } from '../../../test/backend/site'
import { minioStandIn } from '../../../test/backend/files'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { anyOf, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { filesRouter, shareRouter } from '../../../../../backend/src/files/routes/files'
import { artifactsRouter } from '../../../../../backend/src/files/routes/artifacts'
import { FileService, type PlaceState as BackendPlaceState } from '../../../../../backend/src/files/services/FileService'
import { ArtifactService } from '../../../../../backend/src/files/services/ArtifactService'
import { MinioArtifactStores, type MinioReach } from '../../../../../backend/src/files/services/MinioArtifactStore'
import type { FileEntry, FileServer as BackendFileServer } from '../../../../../backend/src/files/lib/file-places'
import type { FileShare as BackendFileShare } from '../../../../../backend/src/files/lib/file-shares'
import { authorize } from '../../../../../backend/src/platform/lib/permissions'
import type { DeploymentMetadata } from '../../../../../backend/src/platform/lib/types'

const minio = await minioStandIn()
const minioStarts: { ownerId: string; name: string; clusterId: string }[] = []

const backend = await startBackend(({ api, db }) => {
  const files = new FileService({
    store: db,
    open: minio.open,
    deployMinio: async (ownerId, request) => {
      minioStarts.push({ ownerId, ...request })
      await db.infrastructure.saveDeployment({ id: 'started-minio', name: request.name, appType: 'minio', status: 'deploying', clusterId: request.clusterId, ownerId, strategy: 'native' } as DeploymentMetadata)
      return { deploymentId: 'started-minio' }
    },
    defaultCluster: 'machine-desk',
  })
  const minioStores = new MinioArtifactStores(outsideThisTier<MinioReach>('the person\'s MinIO', { deployments: () => db.infrastructure.getDeployments() }))
  api.use('/files', filesRouter({
    files,
    getOwnedProject: async (id, principal) => {
      const project = (await db.projects.getProjects()).find((entry) => entry.id === id)
      return project && authorize(principal, 'see', { kind: 'project', ownerId: project.ownerId }).allowed ? project : undefined
    },
  }))
  api.use('/share', shareRouter({ files }))
  api.use('/artifacts', artifactsRouter({ artifacts: new ArtifactService({ records: db.files, minioFor: (ownerId) => minioStores.storeFor(ownerId) }), hasMinio: (ownerId) => minioStores.hasMinio(ownerId) }))
})

const owner = await backend.signIn()
await backend.db.projects.saveProjectInfo({ id: 'shop', name: 'Shop', ownerId: owner.id, createdAt: new Date().toISOString() } as never)
await backend.db.projects.saveProjectInfo({ id: 'bare', name: 'Bare', ownerId: owner.id, createdAt: new Date().toISOString() } as never)

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads servers, places, files and links as the backend describes them', () => {
    expectTypeOf<Wire<BackendFileServer>>().toExtend<FileServer>()
    expectTypeOf<Wire<BackendPlaceState>>().toExtend<PlaceState>()
    expectTypeOf<Wire<FileEntry>>().toExtend<StoredFile>()
    expectTypeOf<Wire<BackendFileShare>>().toExtend<FileShare>()
  })
})

describe('a person\'s files on their own MinIO, as the file browser asks for them', () => {
  it('has no file server and nowhere to put files before MinIO runs', async () => {
    expect(await getFileServers()).toEqual({ servers: [] })
    expect(await getArtifactStorage()).toEqual({ minio: false })
    expect(await getFilePlace('shop')).toEqual({ state: 'none' })
    await expect(listStoredFiles({ kind: 'project', projectId: 'shop' }, '')).rejects.toMatchObject({ response: { status: 409, data: { error: 'This project has no file server yet.' } } })
    await expect(listStoredFiles({ kind: 'mine' }, '')).rejects.toMatchObject({ response: { status: 409, data: { error: 'You have no default file server yet.' } } })
  })

  it('starts MinIO for a project, which is then starting', async () => {
    expect(await startProjectMinio('bare')).toEqual({ state: 'starting', place: { kind: 'minio', deploymentId: 'started-minio', folder: 'bare' }, server: 'koala-files' })
    expect(minioStarts).toEqual([{ ownerId: owner.id, name: 'koala-files', clusterId: 'machine-desk' }])
    await expect(listStoredFiles({ kind: 'project', projectId: 'bare' }, '')).rejects.toMatchObject({ response: { status: 409, data: { error: 'koala-files is still starting.' } } })
  })

  it('lists a running MinIO, makes it the default and chooses it for a project', async () => {
    await backend.db.infrastructure.saveDeployment({ id: 'minio-1', name: 'my-minio', appType: 'minio', status: 'running', clusterId: 'machine-desk', ownerId: owner.id, minioRootPassword: 'secret', strategy: 'native' } as DeploymentMetadata)
    expect(await getArtifactStorage()).toEqual({ minio: true })
    expect(await getFileServers()).toEqual({ servers: [{ kind: 'minio', deploymentId: 'minio-1', name: 'my-minio', clusterId: 'machine-desk' }] })
    expect(await setDefaultFileServer('minio-1')).toEqual({ defaultId: 'minio-1' })
    await expect(setDefaultFileServer('nothing')).rejects.toMatchObject({ response: { status: 400, data: { error: 'That is not one of your running file servers.' } } })
    expect(await getFilePlace('shop')).toEqual({ state: 'ready', place: { kind: 'minio', deploymentId: 'minio-1', folder: 'shop' }, server: objectWith({ deploymentId: 'minio-1' }), chosen: false })
    expect(await chooseFileServer('shop', 'minio-1')).toEqual(objectWith({ state: 'ready', chosen: true }))
  })

  it('uploads a file with its type, lists, reads, searches, moves and removes it', async () => {
    const shop = { kind: 'project' as const, projectId: 'shop' }
    expect(await uploadStoredFile(shop, 'docs/brief.md', new Blob(['# The brief'], { type: 'text/markdown' }))).toEqual({ path: 'docs/brief.md' })
    expect(minio.typeOf('shop', 'docs/brief.md')).toBe('text/markdown')
    expect(await listStoredFiles(shop, '')).toEqual([{ name: 'docs', path: 'docs', type: 'dir' }])
    expect(await listStoredFiles(shop, 'docs')).toEqual([{ name: 'brief.md', path: 'docs/brief.md', type: 'file', size: 11 }])
    expect(await readStoredText(shop, 'docs/brief.md')).toBe('# The brief')
    expect(await searchStoredFiles(shop, 'brief')).toEqual([objectWith({ path: 'docs/brief.md' })])
    expect(await searchStoredFiles(shop, ' ')).toEqual([])
    expect(await makeStoredFolder(shop, 'archive')).toEqual({ path: 'archive' })
    expect(await moveStoredFile(shop, 'docs/brief.md', 'archive/brief.md')).toEqual({ path: 'archive/brief.md' })
    expect(await listStoredFiles(shop, 'archive')).toEqual([objectWith({ path: 'archive/brief.md' })])
    await expect(readStoredText(shop, 'docs/brief.md')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(listStoredFiles(shop, '../escape')).rejects.toMatchObject({ response: { status: 400 } })
    expect(await removeStoredFile(shop, 'archive/brief.md')).toEqual({ path: 'archive/brief.md' })
    expect(await listStoredFiles(shop, 'archive')).toEqual([])
  })

  it('keeps the person\'s own files under their default server', async () => {
    expect(await uploadStoredFile({ kind: 'mine' }, 'notes.txt', new Blob(['mine'], { type: 'text/plain' }))).toEqual({ path: 'notes.txt' })
    expect(await listStoredFiles({ kind: 'mine' }, '')).toEqual([objectWith({ path: 'notes.txt' })])
  })

  it('shares a file by a link that opens with no session, lists it and revokes it', async () => {
    const shared = await shareStoredFile({ kind: 'mine' }, 'notes.txt', 7)
    expect(shared).toEqual(objectWith({ id: anyOf(String), token: anyOf(String), ownerId: owner.id, path: 'notes.txt', name: 'notes.txt', expiresAt: anyOf(String) }))
    await expect(shareStoredFile({ kind: 'mine' }, 'notes.txt', 3 as 7)).rejects.toMatchObject({ response: { status: 400 } })
    expect(await listFileShares()).toEqual([objectWith({ id: shared.id, path: 'notes.txt' })])
    const opened = await fetch(shareUrl(shared.token, backend.origin))
    expect([opened.status, await opened.text()]).toEqual([200, 'mine'])
    expect(await revokeFileShare(shared.id)).toEqual({ id: shared.id })
    expect(await listFileShares()).toEqual([])
    expect((await fetch(shareUrl(shared.token, backend.origin))).status).toBe(404)
  })
})

describe('another person\'s files, as the file browser asks for them', () => {
  it('reaches none of the first person\'s projects or servers', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await getFileServers()).toEqual({ servers: [] })
    await expect(getFilePlace('shop')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Project not found' } } })
    await expect(listStoredFiles({ kind: 'project', projectId: 'shop' }, '')).rejects.toMatchObject({ response: { status: 404 } })
    await expect(chooseFileServer('shop', 'minio-1')).rejects.toMatchObject({ response: { status: 404 } })
    expect(await listFileShares()).toEqual([])
  })
})
