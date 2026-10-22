import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TreeModels } from './TreeModels'
import * as groveApi from '../../api/grove'
import * as modelsApi from '../../../../api/models'
import * as credentialsApi from '../../../../api/credentials'
import * as clustersApi from '../../../../api/clusters'
import * as localAgentsApi from '../../../../api/local-agents'
import { machineChoiceLabel } from '../../../../lib/machine-rows'
import type { ModelProvider } from '../../../../api/models'

vi.mock('../../api/grove', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  getTreeModels: vi.fn(),
  setTreeModel: vi.fn(),
}))
vi.mock('../../../../api/models', async (orig) => ({
  ...(await orig<typeof modelsApi>()),
  listModels: vi.fn(),
}))
vi.mock('../../../../api/credentials', async (orig) => ({
  ...(await orig<typeof credentialsApi>()),
  listLlmProviders: vi.fn(async () => []),
}))
vi.mock('../../../../api/clusters', async (orig) => ({
  ...(await orig<typeof clustersApi>()),
  listClusters: vi.fn(async () => [{ id: 'c1', name: 'provisioning-lunorica' }]),
}))

const desk = [{
  id: 'd1', name: 'desk', rootDir: '/home/me/koala', createdAt: 't', online: true, manualAgents: [],
  agents: [{ id: 'antigravity', title: 'Antigravity', state: 'ready', source: 'found' }],
}] as unknown as localAgentsApi.LocalAgentDevice[]

vi.mock('../../../../api/local-agents', async (orig) => ({
  ...(await orig<typeof localAgentsApi>()),
  useLocalAgentDevices: vi.fn(() => ({ data: desk })),
  useMachineChoiceLabel: vi.fn((id: string | null | undefined) => machineChoiceLabel(id, desk)),
}))

const tabby = { id: 'tabby', name: 'Tabbyapi-Production', source: 'deployment', kind: 'tabbyapi', model: 'Qwen3.8-27B', clusterId: 'c1', contextTokens: 32_000 } as ModelProvider
const vllm = { id: 'vllm', name: 'Vllm-Coder', source: 'deployment', kind: 'vllm', model: 'Coder-32B', clusterId: 'c1', contextTokens: 64_000 } as ModelProvider

const executor: groveApi.TreeModelRow = { agent: 'executor', name: 'Executor', describe: 'Does the tasks', own: { modelId: 'tabby' } }
const judge: groveApi.TreeModelRow = { agent: 'leaf-judge', name: 'Leaf judge', own: { modelId: 'tabby' } }
const planner: groveApi.TreeModelRow = { agent: 'planner', name: 'Planner', own: { machine: 'machine:desk:gemini' } }

const renderIt = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TreeModels treeId="t1" />
  </QueryClientProvider>,
)

describe('the models a tree works with', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(modelsApi.listModels).mockResolvedValue([tabby, vllm])
  })

  it('shows what each agent uses on its own, and keeps a choice for one agent', async () => {
    vi.mocked(groveApi.getTreeModels).mockResolvedValue([executor, judge, planner])
    vi.mocked(groveApi.setTreeModel).mockResolvedValue([executor, { ...judge, chosen: { modelId: 'vllm' } }, planner])
    renderIt()

    expect(await screen.findAllByText('Its own: [TabbyAPI] Qwen3.8-27B')).toHaveLength(2)
    expect(screen.getByText('Always runs on its machine (set in the Studio)')).toBeInTheDocument()
    expect(screen.getAllByText('Change')).toHaveLength(2)

    fireEvent.click(screen.getAllByText('Change')[1]!)
    fireEvent.click(await screen.findByLabelText('Expand vLLM'))
    fireEvent.click(await screen.findByText(/Coder-32B/))
    await waitFor(() => expect(groveApi.setTreeModel).toHaveBeenCalledWith('t1', 'leaf-judge', 'vllm'))
    expect(await screen.findByText('chosen for this tree')).toBeInTheDocument()
  })

  it('puts an agent back on its own, and says when a chosen model is gone', async () => {
    vi.mocked(groveApi.getTreeModels).mockResolvedValue([{ ...executor, chosen: { modelId: 'old', gone: true } }])
    vi.mocked(groveApi.setTreeModel).mockResolvedValue([executor])
    renderIt()

    expect(await screen.findByText(/old is no longer among your models/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Change'))
    fireEvent.click(await screen.findByText('Its own: [TabbyAPI] Qwen3.8-27B'))
    await waitFor(() => expect(groveApi.setTreeModel).toHaveBeenCalledWith('t1', 'executor', null))
  })

  it('offers the agents on your machines to an agent whose procedure hands work to one, and names the machine once chosen', async () => {
    const judgeNoMachine = { ...judge, noMachine: true as const }
    vi.mocked(groveApi.getTreeModels).mockResolvedValue([executor, judgeNoMachine])
    vi.mocked(groveApi.setTreeModel).mockResolvedValue([{ ...executor, chosen: { modelId: 'machine:d1:antigravity' } }, judgeNoMachine])
    renderIt()

    fireEvent.click((await screen.findAllByText('Change'))[0]!)
    fireEvent.click(await screen.findByLabelText('Expand desk'))
    fireEvent.click(screen.getByTitle('Antigravity answers on desk, with its own tools'))
    await waitFor(() => expect(groveApi.setTreeModel).toHaveBeenCalledWith('t1', 'executor', 'machine:d1:antigravity'))
    expect(await screen.findByText('Antigravity · desk')).toBeInTheDocument()

    fireEvent.click(screen.getAllByText('Change')[1]!)
    expect(screen.queryByLabelText('Expand desk')).toBeNull()
    expect(screen.getByText(/Leaf judge's procedure has no way to hand its work to a machine/)).toBeInTheDocument()
  })
})
