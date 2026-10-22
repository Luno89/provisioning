import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'

vi.mock('../../../api/client', () => ({
  api: { get: vi.fn() },
  API_BASE: '/api',
}))

import { api } from '../../../api/client'
import { getGpuStatus } from './clusters'

const mocked = vi.mocked(api)

const failed = (status: number) => new AxiosError(String(status), String(status), undefined, undefined, {
  status, statusText: '', data: {}, headers: {}, config: { headers: new AxiosHeaders() },
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getGpuStatus', () => {
  it('resolves with the cluster\'s GPUs', async () => {
    mocked.get.mockResolvedValue({ data: { vendor: 'NVIDIA', hasGpu: true } })
    await expect(getGpuStatus('c1')).resolves.toEqual({ vendor: 'NVIDIA', hasGpu: true })
    expect(mocked.get).toHaveBeenCalledWith('/clusters/c1/gpu-status')
  })

  it('resolves null, not an error, for a cluster that is not the caller\'s', async () => {
    mocked.get.mockRejectedValue(failed(404))
    await expect(getGpuStatus('provisioning-lunorica')).resolves.toBeNull()
  })

  it('still fails when the cluster cannot be read', async () => {
    mocked.get.mockRejectedValue(failed(500))
    await expect(getGpuStatus('c1')).rejects.toThrow('500')
  })
})
