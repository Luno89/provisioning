import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ProjectSettings from './index'
import * as groveApi from '../../api/grove'
import * as projectsApi from '../../api/projects'
import * as autoModeApi from '../../../engine/api/auto-mode'
import * as releaseApi from '../../../releases/api/release-settings'
import * as modelsApi from '../../../models/api'

vi.mock('../../api/grove', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  listTrees: vi.fn(),
  listBranches: vi.fn(async () => []),
  listLeaves: vi.fn(async () => []),
  getTreeModels: vi.fn(async () => [{ agent: 'executor', name: 'Executor', own: { modelId: 'tabby' } }]),
}))
vi.mock('../../api/projects', async (orig) => ({
  ...(await orig<typeof projectsApi>()),
  listProjects: vi.fn(),
  getProjectRemoval: vi.fn(async () => ({ project: { id: 'p1', name: 'shop' }, trees: [], apps: [], conversations: [], repositories: [] })),
}))
vi.mock('../../../engine/api/auto-mode', async (orig) => ({
  ...(await orig<typeof autoModeApi>()),
  setTreeAutoMode: vi.fn(async () => true),
}))
vi.mock('../../../releases/api/release-settings', async (orig) => ({
  ...(await orig<typeof releaseApi>()),
  getProjectRelease: vi.fn(async () => ({ how: { agent: 'release', app: 'odoo' }, from: 'tree type' })),
  getReleaseOptions: vi.fn(async () => ({ agents: [{ slug: 'release', name: 'Release', needsApp: true }], apps: [{ id: 'odoo', title: 'Odoo' }] })),
}))
vi.mock('../../../releases/components/LiveCustomizations', () => ({ LiveCustomizations: () => <div>live customizations</div> }))
vi.mock('../../../releases/hooks/useClientImport', () => ({ useClientImport: () => ({ data: { open: true } }) }))
vi.mock('../../../releases/components/ClientImport', () => ({ ClientImport: () => <div>client import</div> }))
vi.mock('../../../engine/api/mcp', async (orig) => ({
  ...(await orig<typeof import('../../../engine/api/mcp')>()),
  getMcpCatalogue: vi.fn(async () => ({ servers: [], templates: [] })),
}))
vi.mock('../../../models/api', async (orig) => ({
  ...(await orig<typeof modelsApi>()),
  listModels: vi.fn(async () => [{ id: 'tabby', name: 'Tabby', source: 'deployment', kind: 'tabbyapi', model: 'Qwen3.8-27B' }]),
}))

const tree = { id: 't1', name: 'Shop', type: 'odoo-addons', branchCount: 1, updatedAt: 'a', projectIds: ['p1'] }

const renderIt = (props: { treeId?: string; projectId?: string }) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ProjectSettings {...props} onDeleted={() => undefined} />
  </QueryClientProvider>,
)

describe('a tree\'s settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(groveApi.listTrees).mockResolvedValue([tree])
    vi.mocked(projectsApi.listProjects).mockResolvedValue([{ id: 'p1', name: 'shop', ownerId: 'u1' }] as never)
  })

  it('gathers the tree\'s models, auto mode, how its project releases and deleting either, in one place', async () => {
    renderIt({ treeId: 't1' })
    expect(await screen.findByText('Models')).toBeInTheDocument()
    expect(screen.getByText('Auto mode', { selector: 'h2' })).toBeInTheDocument()
    expect(screen.getByText('Releases')).toBeInTheDocument()
    expect(screen.getByText('Made in the live app')).toBeInTheDocument()
    expect(screen.getByText('Start from a client\'s database')).toBeInTheDocument()
    expect(screen.getByText('Delete the tree')).toBeInTheDocument()
    expect(screen.getByText('Delete the project')).toBeInTheDocument()
    expect(await screen.findByText('Its own: [TabbyAPI] Qwen3.8-27B')).toBeInTheDocument()
    expect(await screen.findByLabelText("How this project's builds are released")).toBeInTheDocument()
  })

  it('shows only the project\'s settings for a project with no tree', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([])
    renderIt({ projectId: 'p1' })
    expect(await screen.findByText('Releases')).toBeInTheDocument()
    expect(screen.getByText('Delete the project')).toBeInTheDocument()
    expect(screen.queryByText('Models')).toBeNull()
    expect(screen.queryByText('Delete the tree')).toBeNull()
  })

  it('puts the tree in auto mode, and shows it on once the tree says so', async () => {
    vi.mocked(groveApi.listTrees).mockImplementation(async () => (vi.mocked(autoModeApi.setTreeAutoMode).mock.calls.length ? [{ ...tree, updatedAt: 'b', autoMode: true }] : [tree]))
    renderIt({ treeId: 't1' })

    const box = await screen.findByLabelText('Auto mode')
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(autoModeApi.setTreeAutoMode).toHaveBeenCalledWith('t1', true))
    await waitFor(() => expect(screen.getByLabelText('Auto mode')).toBeChecked())
  })
})
