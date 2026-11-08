import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as filesApi from '../../files/api/files'
import { useChatAttachments } from './useChatAttachments'

vi.mock('../../files/api/files', async (orig) => ({
  ...(await orig<typeof filesApi>()),
  uploadStoredFile: vi.fn(),
}))

beforeEach(() => { vi.clearAllMocks() })

const inChat = (id: string) => vi.fn(async () => id)

describe('files attached in a chat', () => {
  it('go to the chat\'s folder in its project, and are ready with the stored file\'s id', async () => {
    vi.mocked(filesApi.uploadStoredFile).mockImplementation(async (_scope, path, _file, onProgress) => { onProgress?.(1); return { path, id: 'file-1' } })
    const conversation = inChat('c1')
    const { result } = renderHook(() => useChatAttachments({ id: 'p1', name: 'Shop' }, conversation))
    const pdf = new File(['%PDF'], 'a/brief.pdf', { type: 'application/pdf' })
    act(() => result.current.attach([{ path: 'brief.pdf', file: pdf }]))
    expect(result.current.uploading).toBe(true)
    await waitFor(() => expect(result.current.ready).toHaveLength(1))
    expect(vi.mocked(filesApi.uploadStoredFile).mock.calls[0]!.slice(0, 3)).toEqual([{ kind: 'project', projectId: 'p1' }, 'chats/c1/a_brief.pdf', pdf])
    expect(result.current.ready[0]).toEqual({ fileId: 'file-1', name: 'a_brief.pdf', size: 4, type: 'application/pdf', project: { id: 'p1', name: 'Shop' } })
    act(() => result.current.clear())
    expect(result.current.attached).toEqual([])
  })

  it('go to the chat\'s own files when it has no project', async () => {
    vi.mocked(filesApi.uploadStoredFile).mockImplementation(async (_scope, path) => ({ path, id: 'file-2' }))
    const { result } = renderHook(() => useChatAttachments(undefined, inChat('c2')))
    act(() => result.current.attach([{ path: 'x.png', file: new File(['x'], 'x.png') }]))
    await waitFor(() => expect(result.current.ready).toEqual([{ fileId: 'file-2', name: 'x.png', size: 1 }]))
    expect(vi.mocked(filesApi.uploadStoredFile).mock.calls[0]!.slice(0, 2)).toEqual([{ kind: 'conversation', conversationId: 'c2' }, 'x.png'])
  })

  it('take the next free name when the chat already has a file by that name, and say the name it was kept under', async () => {
    const taken = Object.assign(new Error('409'), { isAxiosError: true, response: { status: 409, data: { error: 'photo.png is already there', exists: true } } })
    vi.mocked(filesApi.uploadStoredFile).mockImplementation(async (_scope, path) => {
      if (path === 'photo.png' || path === 'photo (2).png') throw taken
      return { path, id: 'file-3' }
    })
    const { result } = renderHook(() => useChatAttachments(undefined, inChat('c4')))
    act(() => result.current.attach([{ path: 'photo.png', file: new File(['png'], 'photo.png') }]))
    await waitFor(() => expect(result.current.ready).toEqual([{ fileId: 'file-3', name: 'photo (3).png', size: 3 }]))
    expect(vi.mocked(filesApi.uploadStoredFile).mock.calls.map((call) => call[1])).toEqual(['photo.png', 'photo (2).png', 'photo (3).png'])
    expect(result.current.attached[0]?.name).toBe('photo (3).png')
  })

  it('try no other name when an upload fails for any other reason', async () => {
    vi.mocked(filesApi.uploadStoredFile).mockRejectedValue(Object.assign(new Error('409'), { isAxiosError: true, response: { status: 409, data: { error: 'photo.png is a folder' } } }))
    const { result } = renderHook(() => useChatAttachments(undefined, inChat('c5')))
    act(() => result.current.attach([{ path: 'photo.png', file: new File(['png'], 'photo.png') }]))
    await waitFor(() => expect(result.current.attached[0]?.state).toBe('failed'))
    expect(vi.mocked(filesApi.uploadStoredFile)).toHaveBeenCalledTimes(1)
  })

  it('keep why one failed to upload', async () => {
    vi.mocked(filesApi.uploadStoredFile).mockRejectedValue(Object.assign(new Error('507'), { response: { data: { error: 'The instance\'s files are full.' } } }))
    const { result } = renderHook(() => useChatAttachments(undefined, inChat('c3')))
    act(() => result.current.attach([{ path: 'x.png', file: new File(['x'], 'x.png') }]))
    await waitFor(() => expect(result.current.attached[0]?.state).toBe('failed'))
    expect(result.current.attached[0]?.why).toBe('The instance\'s files are full.')
    expect(result.current.ready).toEqual([])
  })

  it('upload nothing and say why when the chat could not be made', async () => {
    const { result } = renderHook(() => useChatAttachments(undefined, vi.fn(async () => { throw Object.assign(new Error('500'), { response: { data: { error: 'Mongo is down.' } } }) })))
    act(() => result.current.attach([{ path: 'x.png', file: new File(['x'], 'x.png') }]))
    await waitFor(() => expect(result.current.attached[0]?.why).toBe('Mongo is down.'))
    expect(filesApi.uploadStoredFile).not.toHaveBeenCalled()
  })
})
