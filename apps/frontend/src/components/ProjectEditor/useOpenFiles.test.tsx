import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AxiosError } from 'axios'
import { useOpenFiles } from './useOpenFiles.js'
import * as projectFilesApi from '../../api/project-files.js'

vi.mock('../../api/project-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof projectFilesApi>()),
  getProjectFileContent: vi.fn(),
  saveProjectFileContent: vi.fn(),
  deleteProjectFile: vi.fn(),
}))

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const conflictError = () => {
  const err = new AxiosError('conflict')
  err.response = { status: 409, data: {}, statusText: '', headers: {}, config: {} as never }
  return err
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe('useOpenFiles', () => {
  it('opens a file, loading its content and sha', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's1' })
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })

    await act(async () => { await result.current.openFile('a.ts') })

    expect(result.current.active).toMatchObject({ path: 'a.ts', content: 'x', savedContent: 'x', sha: 's1' })
    expect(result.current.activePath).toBe('a.ts')
  })

  it('records an error on the file row when opening fails, rather than throwing', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockRejectedValue(new Error('not found'));
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })

    await act(async () => { await result.current.openFile('missing.ts') })

    expect(result.current.active?.error).toMatch(/not found/)
  })

  it('saves, clearing the dirty state and updating the sha', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's1' })
    vi.mocked(projectFilesApi.saveProjectFileContent).mockResolvedValue({ sha: 's2' })
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })
    await act(async () => { await result.current.openFile('a.ts') })

    act(() => { result.current.changeContent('a.ts', 'y') })
    expect(result.current.active?.content).toBe('y')

    await act(async () => { await result.current.saveFile('a.ts') })

    expect(result.current.active).toMatchObject({ content: 'y', savedContent: 'y', sha: 's2' })
  })

  it('surfaces a 409 as a conflict rather than an inline error', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's1' })
    vi.mocked(projectFilesApi.saveProjectFileContent).mockRejectedValue(conflictError())
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })
    await act(async () => { await result.current.openFile('a.ts') })
    act(() => { result.current.changeContent('a.ts', 'y') })

    await act(async () => { await result.current.saveFile('a.ts') })

    expect(result.current.conflictPath).toBe('a.ts')
    expect(result.current.active?.error).toBeUndefined()
  })

  it('reloading after a conflict clears the conflict banner', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's1' })
    vi.mocked(projectFilesApi.saveProjectFileContent).mockRejectedValue(conflictError())
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })
    await act(async () => { await result.current.openFile('a.ts') })
    act(() => { result.current.changeContent('a.ts', 'y') })
    await act(async () => { await result.current.saveFile('a.ts') })
    expect(result.current.conflictPath).toBe('a.ts')

    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'server-latest', sha: 's3' })
    await act(async () => { await result.current.loadFile('a.ts') })

    expect(result.current.conflictPath).toBeNull()
    expect(result.current.active).toMatchObject({ content: 'server-latest', sha: 's3' })
  })

  it('closes a clean file without confirming', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's1' })
    const confirmSpy = vi.spyOn(window, 'confirm')
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })
    await act(async () => { await result.current.openFile('a.ts') })

    act(() => { result.current.closeFile('a.ts') })

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(result.current.openFiles).toHaveLength(0)
  })

  it('asks for confirmation before discarding a dirty file, and keeps it open when declined', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's1' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })
    await act(async () => { await result.current.openFile('a.ts') })
    act(() => { result.current.changeContent('a.ts', 'dirty') })

    act(() => { result.current.closeFile('a.ts') })

    expect(confirmSpy).toHaveBeenCalled()
    expect(result.current.openFiles).toHaveLength(1)
  })

  it('deletes a file after confirming, and closes its tab', async () => {
    vi.mocked(projectFilesApi.getProjectFileContent).mockResolvedValue({ path: 'a.ts', content: 'x', sha: 's1' })
    vi.mocked(projectFilesApi.deleteProjectFile).mockResolvedValue({ success: true })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { result } = renderHook(() => useOpenFiles('proj-1'), { wrapper })
    await act(async () => { await result.current.openFile('a.ts') })

    await act(async () => { await result.current.deleteFile('a.ts') })

    await waitFor(() => expect(result.current.openFiles).toHaveLength(0))
    expect(projectFilesApi.deleteProjectFile).toHaveBeenCalledWith('proj-1', 'a.ts', 's1')
  })
})
