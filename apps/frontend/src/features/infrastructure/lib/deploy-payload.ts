import type { WizardData } from './wizard-defaults'

type Payload = Record<string, unknown>

const whole = (value: string): number | undefined => (value.trim() === '' ? undefined : Number(value))

function withoutOtherAppsFields(data: WizardData): Payload {
  const { odooRepo: _odooRepo, odooTag: _odooTag, pgRepo: _pgRepo, pgTag: _pgTag, ...rest } = data
  return rest
}

const defined = (payload: Payload): Payload => Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))

export function deployPayloadOf(data: WizardData): Payload {
  return defined(payloadOf(data))
}

function payloadOf(data: WizardData): Payload {
  if (data.appType === 'vllm') {
    return {
      ...withoutOtherAppsFields(data),
      vllmModel: data.vllmModel,
      vllmGpuCount: Number(data.vllmGpuCount),
      vllmGpuVendor: data.vllmGpuVendor,
      vllmHfToken: data.vllmHfToken || undefined,
      vllmMaxModelLen: whole(data.vllmMaxModelLen),
      vllmGpuMemUtil: data.vllmGpuMemUtil ? parseFloat(data.vllmGpuMemUtil) : undefined,
      vllmExtraArgs: data.vllmExtraArgs || undefined,
      vllmToolCallingEnabled: data.vllmToolCallingEnabled,
      vllmToolCallParser: data.vllmToolCallingEnabled ? data.vllmToolCallParser || undefined : undefined,
      vllmServedModelName: data.vllmServedModelName || undefined,
      vllmMaxNumSeqs: whole(data.vllmMaxNumSeqs),
      vllmDtype: data.vllmDtype || undefined,
      appType: 'vllm',
      strategy: 'native',
    }
  }
  if (data.appType === 'tabbyapi') {
    return {
      ...withoutOtherAppsFields(data),
      tabbyGpuCount: Number(data.tabbyGpuCount),
      tabbyRevision: data.tabbyRevision || undefined,
      tabbyHfToken: data.tabbyHfToken || undefined,
      tabbyCacheMode: data.tabbyCacheMode || undefined,
      tabbyMaxSeqLen: whole(data.tabbyMaxSeqLen),
      tabbyMaxBatchSize: whole(data.tabbyMaxBatchSize),
      tabbyToolFormat: data.tabbyToolFormat || undefined,
      appType: 'tabbyapi',
      strategy: 'native',
    }
  }
  if (data.appType === 'openwebui') return { ...data, openWebuiTargetId: data.openWebuiTargetId || undefined, webuiWebSearchApiKey: data.webuiWebSearchApiKey || undefined, appType: 'openwebui', strategy: 'native' }
  if (data.appType === 'hermes') return { ...data, hermesTargetId: data.hermesTargetId || undefined, appType: 'hermes', strategy: 'native' }
  if (data.appType === 'palworld') return { ...data, appSettings: { SERVER_NAME: data.name || 'A Palworld Server', PLAYERS: String(parseInt(data.palworldPlayers) || 16) }, appType: 'palworld', strategy: 'native' }
  return data
}
