import { describe, expect, it } from 'vitest'
import { configInputsOf, EMPTY_CONFIG_INPUTS } from './app-config-inputs'
import type { Deployment } from '../types/deployment'

const vllm: Deployment = {
  id: 'd1', name: 'qwen', appType: 'vllm', clusterId: 'c1', status: 'running',
  vllmModel: 'Qwen/Qwen3-8B', vllmGpuCount: 2, vllmGpuVendor: 'nvidia', vllmMaxModelLen: 4096, vllmGpuMemUtil: 0.5,
  vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes', vllmEnablePrefixCaching: true,
}

describe('the settings form of an app', () => {
  it('starts from what the app was deployed with, so saving keeps what the person did not change', () => {
    expect(configInputsOf(vllm)).toMatchObject({
      vllmModel: 'Qwen/Qwen3-8B', vllmGpuCount: '2', vllmGpuVendor: 'nvidia', vllmMaxModelLen: '4096', vllmGpuMemUtil: '0.5',
      vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes', vllmEnablePrefixCaching: true,
    })
  })

  it('shows an app deployed without tool calling as served without it', () => {
    expect(configInputsOf({ ...vllm, vllmToolCallingEnabled: undefined, vllmToolCallParser: undefined })).toMatchObject({ vllmToolCallingEnabled: false, vllmToolCallParser: '' })
  })

  it('never fills in a token, which the app\'s listing never carries', () => {
    expect(configInputsOf({ ...vllm, vllmHfToken: 'hf_x', tabbyHfToken: 'hf_y', webuiWebSearchApiKey: 'k' })).toMatchObject({ vllmHfToken: '', tabbyHfToken: '', webuiWebSearchApiKey: '' })
  })

  it('is empty with no app', () => {
    expect(configInputsOf(null)).toEqual(EMPTY_CONFIG_INPUTS)
  })
})
