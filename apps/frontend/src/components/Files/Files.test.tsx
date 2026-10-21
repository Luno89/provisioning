import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import * as filesApi from '../../api/files'
import * as projectFilesApi from '../../api/project-files'
import FilePlacePicker from './FilePlacePicker'
import StoredFiles from './StoredFiles'
import ProjectStoredFiles from './ProjectStoredFiles'
import RepositoryFiles from './RepositoryFiles'
import DefaultFileServer from './DefaultFileServer'
import FileShares from './FileShares'
import type { PlaceState } from '../../types/files'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}))

vi.mock('../../api/files', async (orig) => ({
  ...(await orig<typeof filesApi>()),
  getFileServers: vi.fn(),
  setDefaultFileServer: vi.fn(async (deploymentId: string | null) => (deploymentId ? { defaultId: deploymentId } : {})),
  getFilePlace: vi.fn(),
  chooseFileServer: vi.fn(),
  startProjectMinio: vi.fn(),
  listStoredFiles: vi.fn(),
  uploadStoredFile: vi.fn(async (_scope: unknown, path: string) => ({ path })),
  removeStoredFile: vi.fn(async (_scope: unknown, path: string) => ({ path })),
  moveStoredFile: vi.fn(async (_scope: unknown, _from: string, to: string) => ({ path: to })),
  makeStoredFolder: vi.fn(async (_scope: unknown, path: string) => ({ path })),
  searchStoredFiles: vi.fn(),
  shareStoredFile: vi.fn(),
  listFileShares: vi.fn(async () => []),
  revokeFileShare: vi.fn(async (id: string) => ({ id })),
  readStoredText: vi.fn(async () => 'the brief, in words'),
}))

vi.mock('../../api/project-files', async (orig) => ({
  ...(await orig<typeof projectFilesApi>()),
  dropIntoRepository: vi.fn(async (_id: string, body: { files: { path: string }[] }) => ({ ok: true, paths: body.files.map((file) => file.path), commit: 'c1' })),
}))

const minio = { kind: 'minio' as const, deploymentId: 'm1', name: 'minio', clusterId: 'c1' }
const ready: PlaceState = { state: 'ready', place: { kind: 'minio', deploymentId: 'm1', folder: 'shop' }, server: minio, chosen: true }

const show = (node: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>,
)

const dropOn = (target: HTMLElement, files: File[]) => {
  const dataTransfer = { types: ['Files'], items: [], files, dropEffect: 'none' }
  fireEvent.dragEnter(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(filesApi.getFileServers).mockResolvedValue({ servers: [minio] })
  vi.mocked(filesApi.listStoredFiles).mockResolvedValue([])
})

describe('where a project\'s files go', () => {
  it('offers the person\'s servers and starting MinIO when it has none, and says when one is starting', async () => {
    let state: PlaceState = { state: 'none' }
    vi.mocked(filesApi.getFilePlace).mockImplementation(async () => state)
    vi.mocked(filesApi.startProjectMinio).mockImplementation(async () => { state = { state: 'starting', place: { kind: 'minio', deploymentId: 'new', folder: 'shop' }, server: 'koala-files' }; return state })
    show(<FilePlacePicker projectId="p1" />)
    expect(await screen.findByText(/no file server yet/)).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'minio' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start MinIO for this project' }))
    expect(await screen.findByText(/koala-files is starting/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start MinIO for this project' })).not.toBeInTheDocument()
  })

  it('chooses a server for the project', async () => {
    let state: PlaceState = { state: 'none' }
    vi.mocked(filesApi.getFilePlace).mockImplementation(async () => state)
    vi.mocked(filesApi.chooseFileServer).mockImplementation(async () => { state = ready; return ready })
    show(<FilePlacePicker projectId="p1" />)
    fireEvent.change(await screen.findByRole('combobox', { name: "The project's file server" }), { target: { value: 'm1' } })
    await waitFor(() => expect(filesApi.chooseFileServer).toHaveBeenCalledWith('p1', 'm1'))
    expect(await screen.findByText(/minio \(MinIO\), in the folder shop/)).toBeInTheDocument()
  })
})

describe('a project\'s stored files', () => {
  it('lists them with their sizes and download links, uploads what is dropped into the folder it is dropped on', async () => {
    vi.mocked(filesApi.listStoredFiles).mockImplementation(async (_scope, dir) => (dir === '' ? [{ name: 'docs', path: 'docs', type: 'dir' }, { name: 'brief.pdf', path: 'brief.pdf', type: 'file', size: 2048 }] : []))
    show(<StoredFiles scope={{ kind: 'project', projectId: 'p1' }} />)
    expect(await screen.findByText('brief.pdf')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download brief.pdf' })).toHaveAttribute('href', expect.stringContaining('/files/projects/p1/content?path=brief.pdf'))
    const pdf = new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' })
    const docsTarget = screen.getAllByTestId('drop-target').find((element) => element.getAttribute('aria-label') === 'Drop to add to docs')!
    await act(async () => { dropOn(docsTarget, [pdf]) })
    await waitFor(() => expect(filesApi.uploadStoredFile).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 'docs/spec.pdf', pdf, expect.any(Function)))
  })

  it('removes only on a second click, and renames in place', async () => {
    vi.mocked(filesApi.listStoredFiles).mockResolvedValue([{ name: 'a.txt', path: 'a.txt', type: 'file', size: 1 }])
    show(<StoredFiles scope={{ kind: 'mine' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove a.txt' }))
    expect(filesApi.removeStoredFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.txt for good' }))
    await waitFor(() => expect(filesApi.removeStoredFile).toHaveBeenCalledWith({ kind: 'mine' }, 'a.txt'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename a.txt' }))
    const name = screen.getByRole('textbox', { name: 'New name for a.txt' })
    fireEvent.change(name, { target: { value: 'b.txt' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(filesApi.moveStoredFile).toHaveBeenCalledWith({ kind: 'mine' }, 'a.txt', 'b.txt'))
  })

  it('holds a drop while the project has no server, and adds it once one is running', async () => {
    let state: PlaceState = { state: 'none' }
    vi.mocked(filesApi.getFilePlace).mockImplementation(async () => state)
    vi.mocked(filesApi.chooseFileServer).mockImplementation(async () => { state = ready; return ready })
    show(<ProjectStoredFiles projectId="p1" />)
    await screen.findByText(/no file server yet/)
    const photo = new File(['x'], 'photo.jpg', { type: 'image/jpeg' })
    await act(async () => { dropOn(screen.getAllByTestId('drop-target')[0]!, [photo]) })
    expect(await screen.findByTestId('held-files')).toHaveTextContent('1 file waiting')
    expect(filesApi.uploadStoredFile).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox', { name: "The project's file server" }), { target: { value: 'm1' } })
    await waitFor(() => expect(filesApi.uploadStoredFile).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 'photo.jpg', photo, expect.any(Function)))
  })
})

describe('browsing a project\'s files', () => {
  const scope = { kind: 'project' as const, projectId: 'p1' }
  const listing = [
    { name: 'docs', path: 'docs', type: 'dir' as const },
    { name: 'b.pdf', path: 'b.pdf', type: 'file' as const, size: 10, modified: '2026-10-02T00:00:00Z' },
    { name: 'a.png', path: 'a.png', type: 'file' as const, size: 999, modified: '2026-10-01T00:00:00Z' },
  ]

  it('makes a folder, finds files by name, and sorts by size', async () => {
    vi.mocked(filesApi.listStoredFiles).mockResolvedValue(listing)
    vi.mocked(filesApi.searchStoredFiles).mockResolvedValue([{ name: 'brief.pdf', path: 'docs/old/brief.pdf', type: 'file' }])
    show(<StoredFiles scope={scope} />)
    await screen.findByText('b.pdf')
    expect(screen.getAllByRole('button', { name: /^Open [ab]\./ }).map((button) => button.textContent)).toEqual(['a.png', 'b.pdf'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'size' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sort descending' }))
    expect(screen.getAllByRole('button', { name: /^Open [ab]\./ }).map((button) => button.textContent)).toEqual(['a.png', 'b.pdf'])

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const name = screen.getByRole('textbox', { name: 'Name of the new folder' })
    fireEvent.change(name, { target: { value: 'invoices' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(filesApi.makeStoredFolder).toHaveBeenCalledWith(scope, 'invoices'))

    fireEvent.change(screen.getByRole('textbox', { name: 'Find in Files' }), { target: { value: 'brief' } })
    expect(await screen.findByText('docs/old/brief.pdf')).toBeInTheDocument()
    await waitFor(() => expect(filesApi.searchStoredFiles).toHaveBeenCalledWith(scope, 'brief'))
  })

  it('moves and removes several at once, and moves one by dragging it onto a folder', async () => {
    vi.mocked(filesApi.listStoredFiles).mockResolvedValue(listing)
    show(<StoredFiles scope={scope} />)
    await screen.findByText('b.pdf')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select a.png' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select b.pdf' }))
    expect(screen.getByTestId('selection')).toHaveTextContent('2 selected')
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }))
    const where = screen.getByRole('textbox', { name: 'Folder to move them to' })
    fireEvent.change(where, { target: { value: 'docs' } })
    fireEvent.keyDown(where, { key: 'Enter' })
    await waitFor(() => expect(filesApi.moveStoredFile).toHaveBeenCalledTimes(2))
    expect(vi.mocked(filesApi.moveStoredFile).mock.calls.map((call) => [call[1], call[2]])).toEqual([['a.png', 'docs/a.png'], ['b.pdf', 'docs/b.pdf']])

    vi.mocked(filesApi.moveStoredFile).mockClear()
    const data = new Map<string, string>()
    const dataTransfer = { types: [] as string[], setData: (type: string, value: string) => { data.set(type, value); dataTransfer.types = [...data.keys()] }, getData: (type: string) => data.get(type) ?? '', effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Open a.png' }).parentElement!, { dataTransfer })
    const folder = screen.getByText('docs').parentElement!
    fireEvent.dragOver(folder, { dataTransfer })
    fireEvent.drop(folder, { dataTransfer })
    await waitFor(() => expect(filesApi.moveStoredFile).toHaveBeenCalledWith(scope, 'a.png', 'docs/a.png'))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select b.pdf' }))
    fireEvent.click(within(screen.getByTestId('selection')).getByRole('button', { name: /Remove/ }))
    fireEvent.click(within(screen.getByTestId('selection')).getByRole('button', { name: /Remove them for good/ }))
    await waitFor(() => expect(filesApi.removeStoredFile).toHaveBeenCalledWith(scope, 'b.pdf'))
  })

  it('opens a file in a preview it can be shared from', async () => {
    vi.mocked(filesApi.listStoredFiles).mockResolvedValue([{ name: 'brief.md', path: 'brief.md', type: 'file', size: 20 }, { name: 'logo.png', path: 'logo.png', type: 'file', size: 9 }])
    vi.mocked(filesApi.shareStoredFile).mockResolvedValue({ id: 'a'.repeat(32), ownerId: 'u1', path: 'brief.md', name: 'brief.md', createdAt: 't', expiresAt: 't' })
    show(<StoredFiles scope={scope} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open brief.md' }))
    expect(await screen.findByText('the brief, in words')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'How long the link lasts' }), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }))
    await waitFor(() => expect(filesApi.shareStoredFile).toHaveBeenCalledWith(scope, 'brief.md', 30))
    expect((await screen.findByRole('textbox', { name: 'The link' }) as HTMLInputElement).value).toMatch(/\/share\/a{32}$/)
    fireEvent.click(screen.getByRole('button', { name: 'Close the preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open logo.png' }))
    expect(screen.getByRole('img', { name: 'logo.png' })).toHaveAttribute('src', expect.stringContaining('path=logo.png&inline=1'))
  })
})

describe('the person\'s shared links', () => {
  it('lists each with how long it has left, and revokes one', async () => {
    vi.mocked(filesApi.listFileShares).mockResolvedValue([{ id: 'b'.repeat(32), ownerId: 'u1', path: 'docs/a.pdf', name: 'a.pdf', createdAt: 't', expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }])
    show(<FileShares />)
    expect(await screen.findByText('3 days left')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing a.pdf' }))
    await waitFor(() => expect(filesApi.revokeFileShare).toHaveBeenCalledWith('b'.repeat(32)))
  })
})

describe('code dropped on the repository', () => {
  it('is committed in one drop, its bytes sent whole, onto the branch it was dropped on', async () => {
    show(<RepositoryFiles projectId="p1" branch="leaf/l1">{() => <span>tree</span>}</RepositoryFiles>)
    const code = new File([new Uint8Array([0, 255])], 'logo.png')
    await act(async () => { dropOn(screen.getByTestId('drop-target'), [code]) })
    await waitFor(() => expect(projectFilesApi.dropIntoRepository).toHaveBeenCalledWith('p1', { dir: '', files: [{ path: 'logo.png', content: 'AP8=' }], ref: 'leaf/l1' }, expect.any(Function)))
    expect(await screen.findByText('Committed logo.png to the branch leaf/l1.')).toBeInTheDocument()
  })
})

describe('code dropped on a story', () => {
  it('goes to the story and says what became of it', async () => {
    vi.mocked(projectFilesApi.dropIntoRepository).mockResolvedValueOnce({ ok: true, drop: { id: 'd1', branch: 'drop/l1/d1', paths: ['logo.svg'], at: 't', by: 'u1', state: 'conflict', conflicts: ['logo.svg'] }, said: 'logo.svg could not be merged into the story\'s checkout' })
    show(<RepositoryFiles projectId="p1" leafId="l1" title="Code for this story">{() => null}</RepositoryFiles>)
    const code = new File(['<svg/>'], 'logo.svg')
    await act(async () => { dropOn(screen.getByTestId('drop-target'), [code]) })
    await waitFor(() => expect(projectFilesApi.dropIntoRepository).toHaveBeenCalledWith('p1', { dir: '', files: [{ path: 'logo.svg', content: 'PHN2Zy8+' }], leafId: 'l1' }, expect.any(Function)))
    expect(await screen.findByTestId('drop-outcome')).toHaveTextContent('logo.svg could not be merged into the story\'s checkout')
    expect(screen.getByTestId('drop-target')).toHaveAttribute('aria-label', 'Drop code to merge into this story\'s checkout')
  })
})

describe('the person\'s default file server', () => {
  it('is chosen from their running servers, or says how to get one', async () => {
    show(<DefaultFileServer />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Your default file server' }), { target: { value: 'm1' } })
    await waitFor(() => expect(filesApi.setDefaultFileServer).toHaveBeenCalledWith('m1'))
  })

  it('says there is none yet', async () => {
    vi.mocked(filesApi.getFileServers).mockResolvedValue({ servers: [] })
    show(<DefaultFileServer />)
    expect(await screen.findByText(/You have no file server running yet/)).toBeInTheDocument()
  })
})
