import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import * as filesApi from '../../api/files'
import * as projectFilesApi from '../../api/project-files'
import FilePlacePicker from './FilePlacePicker'
import StoredFiles from './StoredFiles'
import ProjectStoredFiles from './ProjectStoredFiles'
import RepositoryFiles from './RepositoryFiles'
import DefaultFileServer from './DefaultFileServer'
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
    expect(screen.getByRole('option', { name: 'minio (MinIO)' })).toBeInTheDocument()
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

describe('code dropped on the repository', () => {
  it('is committed in one drop, its bytes sent whole, onto the branch it was dropped on', async () => {
    show(<RepositoryFiles projectId="p1" branch="leaf/l1">{() => <span>tree</span>}</RepositoryFiles>)
    const code = new File([new Uint8Array([0, 255])], 'logo.png')
    await act(async () => { dropOn(screen.getByTestId('drop-target'), [code]) })
    await waitFor(() => expect(projectFilesApi.dropIntoRepository).toHaveBeenCalledWith('p1', { dir: '', files: [{ path: 'logo.png', content: 'AP8=' }], ref: 'leaf/l1' }, expect.any(Function)))
    expect(await screen.findByText('Committed logo.png to the branch leaf/l1.')).toBeInTheDocument()
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
