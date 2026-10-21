import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as filesApi from '../../../api/files'
import { useChatAttachments } from './useChatAttachments'

vi.mock('../../../api/files', async (orig) => ({
  ...(await orig<typeof filesApi>()),
  uploadStoredFile: vi.fn(),
}))

beforeEach(() => { vi.clearAllMocks() })

describe('files attached in a chat', () => {
  it('go to the chat\'s project, are ready once stored, and say where they are', async () => {
    vi.mocked(filesApi.uploadStoredFile).mockImplementation(async (_scope, path, _file, onProgress) => { onProgress?.(1); return { path } })
    const { result } = renderHook(() => useChatAttachments({ id: 'p1', name: 'Shop' }))
    const pdf = new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' })
    act(() => result.current.attach([{ path: 'brief.pdf', file: pdf }]))
    expect(result.current.uploading).toBe(true)
    await waitFor(() => expect(result.current.ready).toHaveLength(1))
    const [scope, path] = vi.mocked(filesApi.uploadStoredFile).mock.calls[0]!
    expect(scope).toEqual({ kind: 'project', projectId: 'p1' })
    expect(path).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}\/\d{6}-brief\.pdf$/)
    expect(result.current.ready[0]).toEqual({ name: 'brief.pdf', path, size: 4, type: 'application/pdf', project: { id: 'p1', name: 'Shop' } })
    act(() => result.current.clear())
    expect(result.current.attached).toEqual([])
  })

  it('go to the person\'s own files outside a project, and keep why one failed', async () => {
    vi.mocked(filesApi.uploadStoredFile).mockRejectedValue(Object.assign(new Error('409'), { response: { data: { error: 'You have no default file server yet.' } } }))
    const { result } = renderHook(() => useChatAttachments(undefined))
    act(() => result.current.attach([{ path: 'x.png', file: new File(['x'], 'x.png') }]))
    await waitFor(() => expect(result.current.attached[0]?.state).toBe('failed'))
    expect(vi.mocked(filesApi.uploadStoredFile).mock.calls[0]![0]).toEqual({ kind: 'mine' })
    expect(result.current.attached[0]?.why).toBe('You have no default file server yet.')
    expect(result.current.ready).toEqual([])
  })
})
