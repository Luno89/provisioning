import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ProjectStrip from './ProjectStrip'
import * as groveApi from '../../../api/grove'
import * as projectsApi from '../../../api/projects'
import * as releasesApi from '../../../api/releases'
import * as modelsApi from '../../../api/models'
import * as agentsApi from '../../../api/local-agents'
import * as autoModeApi from '../../../api/auto-mode'

vi.mock('../../../api/grove', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  listTrees: vi.fn(), listBranches: vi.fn(), listLeaves: vi.fn(), getTreeRun: vi.fn(), getTreeModels: vi.fn(), runTree: vi.fn(), stopTreeRun: vi.fn(async () => ({ state: 'none' })),
}))
vi.mock('../../../api/projects', async (orig) => ({ ...(await orig<typeof projectsApi>()), listProjects: vi.fn(), listProjectRuns: vi.fn(async () => []) }))
vi.mock('../../../api/releases', async (orig) => ({ ...(await orig<typeof releasesApi>()), listReleases: vi.fn() }))
vi.mock('../../../api/models', async (orig) => ({ ...(await orig<typeof modelsApi>()), listModels: vi.fn(async () => []) }))
vi.mock('../../../api/local-agents', async (orig) => ({ ...(await orig<typeof agentsApi>()), useMachineChoiceLabels: () => (id: string) => (id.startsWith('machine:') ? 'Antigravity · Desk' : undefined) }))
vi.mock('../../../api/auto-mode', async (orig) => ({ ...(await orig<typeof autoModeApi>()), setTreeAutoMode: vi.fn(async () => true) }))
vi.mock('../Workspace/useTreeCards', () => ({ useTreeCards: () => ({ open: [], waiting: [], pending: [], asking: [], count: 0 }) }))
vi.mock('../Workspace/TreeProposalsPanel', () => ({ TreeProposalsPanel: () => null }))
vi.mock('../Workspace/TreeModels', () => ({ TreeModels: ({ treeId }: { treeId: string }) => <div data-testid="tree-models">{treeId}</div> }))
vi.mock('../Workspace/ReleasesPanel', () => ({ Decision: ({ release }: { release: { commit: string } }) => <div data-testid="decision">{release.commit}</div> }))
vi.mock('../Workspace/OpenApp', () => ({ OpenApp: () => <span>Open app</span> }))
vi.mock('../Workspace/SignInReveal', () => ({ SignInReveal: () => <span>Show sign-in</span> }))

const shop = { id: 'p1', name: 'Shop', giteaOwner: 'o', giteaRepo: 'r' }
const tree = { id: 't1', name: 'Delivery Labels', projectIds: ['p1'], autoMode: true }

const renderStrip = (channel?: { open: boolean; onToggle: () => void }) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ProjectStrip treeId="t1" {...(channel ? { channel } : {})} />
  </QueryClientProvider>,
)

beforeEach(() => {
  vi.mocked(groveApi.listTrees).mockResolvedValue([tree] as never)
  vi.mocked(groveApi.listBranches).mockResolvedValue([{ id: 'b1', title: 'Labels', treeId: 't1' }] as never)
  vi.mocked(groveApi.listLeaves).mockResolvedValue([
    { id: 'l1', branchId: 'b1', title: 'The barcode on each label', status: 'running', updatedAt: 'x' },
    { id: 'l2', branchId: 'b1', title: 'The sandbox facts', status: 'pending', updatedAt: 'x' },
  ] as never)
  vi.mocked(projectsApi.listProjects).mockResolvedValue([shop] as never)
  vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'running', startedAt: '2026-10-19T15:00:00Z' })
  vi.mocked(groveApi.getTreeModels).mockResolvedValue([
    { agent: 'executor', name: 'Executor', own: { modelId: 'tabby' }, chosen: { modelId: 'machine:desk:antigravity' } },
    { agent: 'judge', name: 'Judge', own: { modelId: 'tabby' } },
  ])
  vi.mocked(releasesApi.listReleases).mockResolvedValue({
    releases: [
      { id: 'r1', projectId: 'p1', commit: 'e5d23798aaaa', state: 'live', slot: 'a', startedAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' },
      { id: 'r2', projectId: 'p1', commit: 'da775aecbbbb', state: 'preview', slot: 'b', startedAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z' },
    ],
    addresses: {},
  } as never)
})

describe('the strip across the top of a project', () => {
  it('says what is live, what is being worked with a way to stop it, what each agent runs on, and the preview waiting on the person', async () => {
    renderStrip()
    const strip = await screen.findByTestId('project-strip')
    expect(await within(strip).findByRole('heading', { name: 'Shop' })).toBeInTheDocument()
    expect(await within(strip).findByTestId('strip-live')).toHaveTextContent('Live e5d23798')
    expect(await within(strip).findByText('Working on “The barcode on each label”')).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    const runsOn = await within(strip).findByTestId('strip-runs-on')
    expect(runsOn).toHaveTextContent('Executor on Antigravity · Desk · the rest on their own')
    expect(await within(strip).findByTestId('decision')).toHaveTextContent('da775aec')
    expect(strip.querySelector('[data-waiting]')).not.toBeNull()

    fireEvent.click(runsOn)
    expect(await screen.findByTestId('tree-models')).toHaveTextContent('t1')
    expect(screen.getByRole('checkbox', { name: 'Auto mode' })).toBeInTheDocument()
  })

  it('offers to work the ready stories when nothing runs, has nothing waiting when nothing does, and toggles the chat', async () => {
    vi.mocked(groveApi.getTreeRun).mockResolvedValue({ state: 'finished', startedAt: 'x', result: { outcome: 'stopped', awaitingReview: [] } } as never)
    vi.mocked(releasesApi.listReleases).mockResolvedValue({ releases: [], addresses: {} } as never)
    const onToggle = vi.fn()
    renderStrip({ open: true, onToggle })
    expect(await screen.findByText('You stopped the last run · 1 story is ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Work them/ })).toBeInTheDocument()
    expect(screen.getByTestId('project-strip').querySelector('[data-waiting]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Hide the channel/ }))
    expect(onToggle).toHaveBeenCalled()
  })
})
