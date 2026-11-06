import { describe, expect, expectTypeOf, it } from 'vitest'
import { getModelRateLimiterSnapshot, type ModelRateLimitBucketSnapshot } from '@koala/agent-engine'
import { type ModelProvider, type ModelTraffic, getDefaultModel, getModelTraffic, listModels, setDefaultModel, setGlobalModelOverride } from './api'
import { startBackend } from '../../test/backend/site'
import { machinesOf, DATA_KEY, type Machines } from '../../test/backend/machines'
import type { Wire } from '../../test/backend/wire'
import { modelsRouter } from '../../../../backend/src/models/routes/models'
import { ModelService } from '../../../../backend/src/models/services/ModelService'
import { CredentialService } from '../../../../backend/src/infrastructure/services/CredentialService'
import type { ModelProvider as BackendModelProvider } from '../../../../backend/src/models/lib/model-registry'
import type { AppService } from '../../../../backend/src/infrastructure/services/AppService'

let side: Machines | undefined

const backend = await startBackend((site) => {
  side = machinesOf(site)
  const deployments = { getAll: async (owner: string) => (await site.db.infrastructure.getDeployments()).filter((deployment) => deployment.ownerId === owner) } as unknown as AppService
  const unreached = {} as never
  site.api.use('/models', modelsRouter({
    modelService: new ModelService(site.db, deployments, unreached, unreached, unreached, DATA_KEY),
    db: site.db,
    credentialService: new CredentialService(site.db, DATA_KEY),
    machines: side.machines,
    rateLimits: getModelRateLimiterSnapshot,
  }))
})

const owner = await backend.signIn()
await backend.db.models.saveModelEndpoint({ id: 'tabby-qwen', ownerId: owner.id, name: 'Qwen on TabbyAPI', baseUrl: 'http://100.64.0.5:5000/v1', model: 'qwen3-32b', isMesh: true, contextTokens: 32768, createdAt: new Date().toISOString() })

expectTypeOf<Wire<BackendModelProvider>>().toExtend<ModelProvider>()
expectTypeOf<Wire<ModelRateLimitBucketSnapshot>>().toExtend<ModelTraffic>()

describe('the models the browser lists and the account default, against the real models routes', () => {
  it('lists the person\'s own endpoint with what the model picker shows', async () => {
    expect(await listModels()).toEqual([{ id: 'tabby-qwen', name: 'Qwen on TabbyAPI', source: 'endpoint', sourceLabel: 'Custom', model: 'qwen3-32b', baseUrl: 'http://100.64.0.5:5000/v1', isMesh: true, contextTokens: 32768 }])
  })

  it('starts with no default and the override off', async () => {
    expect(await getDefaultModel()).toEqual({ defaultModelId: null, globalModelOverride: false })
  })

  it('makes one of the person\'s models the default, and reads it back', async () => {
    expect(await setDefaultModel('tabby-qwen')).toBe('tabby-qwen')
    expect(await getDefaultModel()).toEqual({ defaultModelId: 'tabby-qwen', globalModelOverride: false })
  })

  it('refuses a model the person does not have as not found', async () => {
    await expect(setDefaultModel('someone-elses')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Model not found' } } })
    expect((await getDefaultModel()).defaultModelId).toBe('tabby-qwen')
  })

  it('refuses an agent on a machine that is not connected, in the words the page shows', async () => {
    const deviceId = await side!.join('desk', (await side!.accounts.createJoinCode(owner.id)).code)
    await side!.agents(deviceId, [{ id: 'claude-code', title: 'Claude Code', state: 'ready', source: 'found' }])
    await expect(setDefaultModel(`machine:${deviceId}:claude-code`)).rejects.toMatchObject({ response: { status: 400, data: { error: 'desk is not connected, so Claude Code cannot answer' } } })
    await expect(setDefaultModel(`machine:${deviceId}:gemini`)).rejects.toMatchObject({ response: { status: 400, data: { error: 'desk has no agent called gemini' } } })
  })

  it('takes a ready agent on a connected machine as the default', async () => {
    const [device] = await backend.db.machines.getLocalAgentDevices()
    await side!.connect(device!.id)
    expect(await setDefaultModel(`machine:${device!.id}:claude-code`)).toBe(`machine:${device!.id}:claude-code`)
    expect((await getDefaultModel()).defaultModelId).toBe(`machine:${device!.id}:claude-code`)
  })

  it('refuses a machine that is not the person\'s as no longer theirs', async () => {
    await expect(setDefaultModel('machine:gone:claude-code')).rejects.toMatchObject({ response: { status: 400, data: { error: 'that machine is not one of yours any more; pick another on My Machines or in the model list' } } })
  })

  it('clears the default with null', async () => {
    expect(await setDefaultModel(null)).toBeNull()
    expect((await getDefaultModel()).defaultModelId).toBeNull()
  })

  it('turns the override on and reads it back', async () => {
    expect(await setGlobalModelOverride(true)).toBe(true)
    expect(await getDefaultModel()).toEqual({ defaultModelId: null, globalModelOverride: true })
  })

  it('reads the model traffic as a list of buckets, empty before any call', async () => {
    expect(await getModelTraffic()).toEqual([])
  })

  it('shows another person none of the first person\'s models', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await listModels()).toEqual([])
    await expect(setDefaultModel('tabby-qwen')).rejects.toMatchObject({ response: { status: 404 } })
  })
})
