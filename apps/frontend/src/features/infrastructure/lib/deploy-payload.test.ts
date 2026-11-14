import { describe, expect, it } from 'vitest'
import { EMPTY_WIZARD_DATA } from './wizard-defaults'
import { deployPayloadOf } from './deploy-payload'

const vllm = { ...EMPTY_WIZARD_DATA, appType: 'vllm', name: 'qwen', clusterId: 'machine-desk', odooRepo: 'vllm/vllm-openai', odooTag: 'latest', pgRepo: '', pgTag: '', vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct', vllmGpuCount: '2', vllmGpuVendor: 'amd' as const, vllmHfToken: 'hf_secret' }

describe('what Deploy sends for a model server', () => {
  it('sends vLLM\'s model, GPUs, vendor and token in their own fields, and no other app\'s image or database fields', () => {
    const payload = deployPayloadOf(vllm)
    expect(payload).toMatchObject({ appType: 'vllm', strategy: 'native', vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct', vllmGpuCount: 2, vllmGpuVendor: 'amd', vllmHfToken: 'hf_secret' })
    for (const field of ['odooRepo', 'odooTag', 'pgRepo', 'pgTag']) expect(payload).not.toHaveProperty(field)
  })

  it('sends 0 GPUs as CPU only, never as one GPU', () => {
    expect(deployPayloadOf({ ...vllm, vllmGpuCount: '0' })).toMatchObject({ vllmGpuCount: 0 })
  })

  it('sends vLLM\'s tool calling on with the parser picked, none for Koala to choose from the model, and no parser when it is off', () => {
    expect(deployPayloadOf(vllm)).toMatchObject({ vllmToolCallingEnabled: true })
    expect(deployPayloadOf(vllm)).not.toHaveProperty('vllmToolCallParser')
    expect(deployPayloadOf({ ...vllm, vllmToolCallParser: 'pythonic' })).toMatchObject({ vllmToolCallingEnabled: true, vllmToolCallParser: 'pythonic' })
    const off = deployPayloadOf({ ...vllm, vllmToolCallingEnabled: false, vllmToolCallParser: 'hermes' })
    expect(off).toMatchObject({ vllmToolCallingEnabled: false })
    expect(off).not.toHaveProperty('vllmToolCallParser')
  })

  it('leaves the token out when none was typed, so the saved one is used', () => {
    expect(deployPayloadOf({ ...vllm, vllmHfToken: '' })).not.toHaveProperty('vllmHfToken')
  })

  it('sends TabbyAPI\'s token only as its own field, and no other app\'s image or database fields', () => {
    const payload = deployPayloadOf({ ...EMPTY_WIZARD_DATA, appType: 'tabbyapi', odooTag: 'latest', pgTag: 'x', tabbyHfToken: 'hf_tabby', tabbyGpuCount: '1' })
    expect(payload).toMatchObject({ appType: 'tabbyapi', tabbyHfToken: 'hf_tabby', tabbyGpuCount: 1 })
    for (const field of ['odooRepo', 'odooTag', 'pgRepo', 'pgTag']) expect(payload).not.toHaveProperty(field)
  })

  it('sends any other app as the wizard holds it', () => {
    const odoo = { ...EMPTY_WIZARD_DATA, appType: 'odoo' }
    expect(deployPayloadOf(odoo)).toEqual(odoo)
  })
})
