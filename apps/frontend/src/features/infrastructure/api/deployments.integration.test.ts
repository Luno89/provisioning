import { describe, expect, expectTypeOf, it } from 'vitest'
import { Server } from 'socket.io'
import { type CatalogueEntry, deployApp, listAppCatalogue, listDeployments } from './deployments'
import { getAppSchema, type AppSettingsSchema } from './app-schemas'
import { EMPTY_WIZARD_DATA } from '../lib/wizard-defaults'
import { deployPayloadOf } from '../lib/deploy-payload'
import { startBackend } from '../../../test/backend/site'
import { DATA_KEY } from '../../../test/backend/machines'
import { outsideThisTier, recordedTemporal } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { deploymentsRouter } from '../../../../../backend/src/infrastructure/routes/deployments'
import { appSchemasRouter } from '../../../../../backend/src/infrastructure/routes/app-schemas'
import { AppService } from '../../../../../backend/src/infrastructure/services/AppService'
import { ClusterService } from '../../../../../backend/src/infrastructure/services/ClusterService'
import { BuilderService } from '../../../../../backend/src/infrastructure/services/BuilderService'
import { TemporalBridge } from '../../../../../backend/src/infrastructure/services/TemporalBridge'
import type { InfrastructureService } from '../../../../../backend/src/infrastructure/services/InfrastructureService'
import type { AppExposureService } from '../../../../../backend/src/infrastructure/services/AppExposureService'
import type { StoredAppSpec } from '../../../../../backend/src/infrastructure/lib/app-spec'
import type { AppSettingsSchema as BackendSchema } from '../../../../../backend/src/infrastructure/lib/app-settings-schema'
import { anyOf, containing, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'
import { testClusterAccess } from '../../../../../backend/src/infrastructure/testing/cluster-access'
import { testDataDir } from '../../../../../backend/src/platform/testing/data-dir'
import { toolCallParsersOn } from '../../../test/backend/tool-calling'

const temporal = recordedTemporal()

const backend = await startBackend(async (site) => {
  const { api, db } = site
  const { parsers } = await toolCallParsersOn(site, {
    'Qwen/Qwen2.5-0.5B-Instruct': { fixture: 'Qwen/Qwen2.5-0.5B-Instruct', as: 'tokenizer_config.json' },
    'someone/their-own-model': { template: '{% for message in messages %}{{ message.content }}{% endfor %}' },
  })
  const host = outsideThisTier<InfrastructureService>('the host\'s kubectl and helm')
  const clusters = new ClusterService(db, testClusterAccess(db, { dataKey: DATA_KEY }))
  const apps = new AppService(db, host, clusters, new BuilderService(db, host))
  const bridge = new TemporalBridge(db, testDataDir(), undefined, DATA_KEY, clusters, { connect: async () => temporal.client, toolCalling: parsers })
  await bridge.start()
  api.use('/deployments', deploymentsRouter({
    appService: apps,
    clusterService: clusters,
    appExposureService: outsideThisTier<AppExposureService>('app exposure'),
    temporalBridge: bridge,
    toolCalling: parsers,
    db,
    io: new Server(),
  }))
  api.use('/app-schemas', appSchemasRouter())
})

const owner = await backend.signIn()
const GPU_MACHINE = { id: 'machine-gpu-desk', name: 'gpu-desk', provider: 'machine' as const, status: 'stopped' as const, ownerId: owner.id, machineId: 'gpu-desk', capacity: { cpuCores: 16, ramGb: 64 }, gpus: [{ vendor: 'nvidia' as const, model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], gpuProblems: [] }
await backend.db.infrastructure.saveCluster(GPU_MACHINE)
await backend.db.infrastructure.saveCluster({ ...GPU_MACHINE, id: 'machine-laptop', name: 'laptop', machineId: 'laptop', capacity: { cpuCores: 8, ramGb: 32 }, gpus: [], gpuProblems: [] })
await backend.db.infrastructure.saveCluster({ ...GPU_MACHINE, id: 'machine-not-mine', name: 'not-mine', machineId: 'not-mine', ownerId: 'someone-else' })

const tabbyFromTheWizard = (clusterId: string) => deployPayloadOf({ ...EMPTY_WIZARD_DATA, name: 'qwen', clusterId, appType: 'tabbyapi' })

interface DeployAccepted { message: string; deploymentName: string; id: string; workflowId: string; state: string }

expectTypeOf<Wire<StoredAppSpec & { deploysFromSpec: boolean }>>().toExtend<CatalogueEntry>()
expectTypeOf<Wire<BackendSchema>>().toExtend<AppSettingsSchema>()

describe('deploying an app, as the deploy wizard asks for it', () => {
  it('reads the catalogue with TabbyAPI and vLLM in it, each saying whether it deploys from its spec', async () => {
    const catalogue = await listAppCatalogue()
    const byId = new Map(catalogue.map((entry) => [entry.id, entry]))
    expect(byId.get('tabbyapi')).toMatchObject({ id: 'tabbyapi', deploysFromSpec: false })
    expect(byId.get('vllm')).toMatchObject({ id: 'vllm', deploysFromSpec: false })
    expect(catalogue.every((entry) => typeof entry.deploysFromSpec === 'boolean')).toBe(true)
  })

  it('reads a game server\'s settings schema, and is told when an app has none', async () => {
    const schema = await getAppSchema('palworld')
    expect(schema.appType).toBe('palworld')
    expect(schema.settings.length).toBeGreaterThan(0)
    expect(schema.categories.length).toBeGreaterThan(0)
    await expect(getAppSchema('tabbyapi')).rejects.toMatchObject({ response: { status: 404, data: { error: 'No settings schema for app type "tabbyapi"' } } })
  })

  it('accepts the wizard\'s TabbyAPI request for a GPU machine, and starts the deploy workflow with what the wizard asked', async () => {
    const accepted = await deployApp<DeployAccepted>(tabbyFromTheWizard(GPU_MACHINE.id))
    expect(accepted).toMatchObject({ message: 'Deployment started', deploymentName: 'qwen', state: 'running' })
    expect(accepted.id).toEqual(anyOf(String))
    const [started] = temporal.started
    expect(started?.options.workflowId).toBe(accepted.workflowId)
    expect(started?.options.args?.[0]).toMatchObject({ name: 'qwen', clusterId: GPU_MACHINE.id, appType: 'tabbyapi', strategy: 'native', tabbyModel: EMPTY_WIZARD_DATA.tabbyModel, tabbyGpuCount: 2, tabbyMaxSeqLen: 32768, tabbyCacheMode: 'Q8', tabbyToolFormat: 'qwen3_coder' })
  })

  it('lists the app it started as deploying', async () => {
    const listed = await listDeployments()
    expect(listed).toEqual([objectWith({ name: 'qwen', appType: 'tabbyapi', clusterId: GPU_MACHINE.id, status: 'deploying' })])
  })

  it('refuses a request for more GPUs than the machine shows, in words the wizard shows', async () => {
    await expect(deployApp(tabbyFromTheWizard('machine-laptop'))).rejects.toMatchObject({ response: { status: 400, data: { error: containing('This app asks for 2 NVIDIA GPUs, and laptop shows none') } } })
  })

  it('answers 404 for a cluster that is someone else\'s or does not exist', async () => {
    await expect(deployApp(tabbyFromTheWizard('machine-not-mine'))).rejects.toMatchObject({ response: { status: 404, data: { error: 'Cluster not found' } } })
    await expect(deployApp(tabbyFromTheWizard('nowhere'))).rejects.toMatchObject({ response: { status: 404, data: { error: 'Cluster not found' } } })
  })

  it('refuses an app Koala makes from a project, and a model cache that is not a folder name', async () => {
    await expect(deployApp({ ...tabbyFromTheWizard(GPU_MACHINE.id), appType: 'gitapp' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'a gitapp app is made by Koala from its project, never deployed by hand' } } })
    await expect(deployApp({ ...tabbyFromTheWizard(GPU_MACHINE.id), tabbyCachePvc: '../etc' })).rejects.toMatchObject({ response: { status: 400 } })
    expect(temporal.started).toHaveLength(1)
  })
})

describe('deploying vLLM with the wizard\'s defaults', () => {
  const vllmFromTheWizard = (model: string) => deployPayloadOf({ ...EMPTY_WIZARD_DATA, name: `vllm-${model.length}`, clusterId: GPU_MACHINE.id, appType: 'vllm', vllmModel: model })

  it('serves tool calling with the parser the backend takes for the model, so a Koala chat can run on it', async () => {
    const accepted = await deployApp<DeployAccepted>(vllmFromTheWizard('Qwen/Qwen2.5-0.5B-Instruct'))
    const started = temporal.started.find((run) => run.options.workflowId === accepted.workflowId)
    expect(started?.options.args?.[0]).toMatchObject({ appType: 'vllm', vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct', vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes' })
  })

  it('is refused, in words the wizard shows, when tool calling is on and no parser is known for the model', async () => {
    await expect(deployApp({ ...vllmFromTheWizard('someone/their-own-model'), vllmToolCallParser: undefined })).rejects.toMatchObject({ response: { status: 400, data: { error: 'someone/their-own-model\'s chat template has no tool call format Koala knows: pick a parser, or turn tool calling off' } } })
  })
})
