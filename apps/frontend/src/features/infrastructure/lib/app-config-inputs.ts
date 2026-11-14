import type { Deployment } from '../types/deployment'

export const EMPTY_CONFIG_INPUTS = {
  webRepo: '', webTag: '', dbRepo: '', dbTag: '',
  vllmModel: '', vllmGpuCount: '1', vllmGpuVendor: 'nvidia', vllmHfToken: '',
  vllmMaxModelLen: '', vllmGpuMemUtil: '', vllmExtraArgs: '',
  vllmToolCallingEnabled: false, vllmToolCallParser: '', vllmServedModelName: '',
  vllmMaxNumSeqs: '', vllmDtype: '', vllmEnablePrefixCaching: false,
  tabbyModel: '', tabbyRevision: '', tabbyGpuCount: '1', tabbyHfToken: '',
  tabbyImageTag: 'latest', tabbyCacheMode: '', tabbyMaxSeqLen: '', tabbyMaxBatchSize: '',
  tabbyReasoning: false, tabbyToolFormat: '', tabbyInlineModelLoading: false,
  tabbyDisableAuth: true, tabbyMemoryLimit: '', tabbyShmSize: '', tabbyCpuLimit: '', tabbyExtraEnv: '',
  openWebuiTargetId: '',
  hermesTargetId: '',
  webuiEnableWebSearch: true, webuiWebSearchEngine: 'duckduckgo', webuiWebSearchApiKey: '',
}

export type ConfigInputs = typeof EMPTY_CONFIG_INPUTS

const NEVER_SHOWN: ReadonlySet<string> = new Set(['vllmHfToken', 'tabbyHfToken', 'webuiWebSearchApiKey'])

export function configInputsOf(deployment: Deployment | null): ConfigInputs {
  const inputs: Record<string, string | boolean> = { ...EMPTY_CONFIG_INPUTS }
  if (!deployment) return inputs as ConfigInputs
  for (const [key, empty] of Object.entries(EMPTY_CONFIG_INPUTS)) {
    const stored = deployment[key]
    if (NEVER_SHOWN.has(key) || stored === undefined || stored === null) continue
    if (typeof empty === 'boolean' && typeof stored === 'boolean') inputs[key] = stored
    else if (typeof empty === 'string' && (typeof stored === 'string' || typeof stored === 'number')) inputs[key] = String(stored)
  }
  return inputs as ConfigInputs
}
