import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectBoard } from './index'
import * as groveApi from '../../api/grove'
import * as projectsApi from '../../api/projects'
import * as engineApi from '../../../../api/engine'
import * as releasesApi from '../../../../api/releases'
import * as chatPackApi from '../../../../api/chat-pack'

vi.mock('../../api/grove', async (orig) => ({ ...(await orig<typeof groveApi>()), listTrees: vi.fn(), listBranches: vi.fn(), listLeaves: vi.fn(), orderFeatures: vi.fn(async () => undefined), orderStories: vi.fn(async () => undefined), getTreeRun: vi.fn(async () => ({ state: 'none' })) }))
vi.mock('../../api/projects', async (orig) => ({ ...(await orig<typeof projectsApi>()), listProjects: vi.fn(), listProjectRuns: vi.fn(async () => []) }))
vi.mock('../../../../api/engine', async (orig) => ({ ...(await orig<typeof engineApi>()), listTasks: vi.fn(async () => []) }))
vi.mock('../../../../api/releases', async (orig) => ({ ...(await orig<typeof releasesApi>()), listReleases: vi.fn(async () => ({ releases: [], addresses: {} })) }))
vi.mock('../../../../api/chat-pack', async (orig) => ({ ...(await orig<typeof chatPackApi>()), createChatConversation: vi.fn() }))
vi.mock('../Workspace/ProjectChannel', () => ({ ProjectChannel: ({ projectId }: { projectId: string }) => <div data-testid="channel">{projectId}</div> }))
vi.mock('../Workspace/TreeProposalsPanel', () => ({ TreeProposalsPanel: () => null }))
vi.mock('../Workspace/TreeConversationsPanel', () => ({ TreeConversationsPanel: ({ onSelect }: { onSelect: (id: string) => void }) => <button type="button" onClick={() => onSelect('conv-1')}>a thread</button> }))
vi.mock('../LeafDetail', () => ({ default: ({ leaf }: { leaf: { title: string } }) => <div data-testid="leaf-detail">{leaf.title}</div> }))
vi.mock('./ItemChat', () => ({ ItemChat: ({ kind, id }: { kind: string; id: string }) => <div data-testid="item-chat">{`${kind} ${id}`}</div> }))
vi.mock('../../../../components/ChatSurface', () => ({ default: ({ conversationId }: { conversationId: string }) => <div data-testid="chat">{conversationId}</div> }))

const shop = { id: 'p1', name: 'Shop', giteaOwner: 'o', giteaRepo: 'r' }
const tree = { id: 't1', name: 'Delivery instructions', projectIds: ['p1'] }

const renderBoard = (props: Parameters<typeof ProjectBoard>[0]) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ProjectBoard {...props} />
  </QueryClientProvider>,
)

beforeEach(() => {
  localStorage.clear()
  vi.mocked(groveApi.listTrees).mockResolvedValue([tree] as never)
  vi.mocked(groveApi.listBranches).mockResolvedValue([{ id: 'b1', title: 'The field', treeId: 't1' }] as never)
  vi.mocked(groveApi.listLeaves).mockResolvedValue([
    { id: 'l1', branchId: 'b1', title: 'Module installs', status: 'succeeded', verified: true, updatedAt: '2026-10-09T00:00:00Z' },
    { id: 'l2', branchId: 'b1', title: 'Browser spec', status: 'running', updatedAt: '2026-10-09T00:00:00Z' },
  ] as never)
  vi.mocked(projectsApi.listProjects).mockResolvedValue([shop] as never)
})

describe('a project\'s board', () => {
  it('shows its epic with each feature\'s stories in their columns, the channel beside it, and no channel once the person closes it', async () => {
    const { unmount } = renderBoard({ treeId: 't1' })
    const epic = await screen.findByRole('region', { name: 'Delivery instructions' })
    const lane = await within(epic).findByRole('row', { name: /The field/ })
    expect(within(lane).getAllByTestId('story-card').map((card) => card.textContent)).toEqual([
      expect.stringContaining('Browser spec'),
      expect.stringContaining('Module installs'),
    ])
    expect(screen.getByTestId('channel')).toHaveTextContent('p1')
    unmount()
    renderBoard({ treeId: 't1', chatOpen: false })
    expect(await screen.findByRole('region', { name: 'Delivery instructions' })).toBeInTheDocument()
    expect(screen.queryByTestId('channel')).toBeNull()
  })

  it('tells the person how a story still to be worked gets worked, and says nothing of it on one that is done', async () => {
    renderBoard({ treeId: 't1' })
    fireEvent.click(await screen.findByRole('button', { name: /Browser spec/ }))
    expect(screen.getByTestId('story-run-tree')).toHaveTextContent('Ready stories are worked in the order you set on the board, with Work them at the top of the page.')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Delivery instructions'))
    fireEvent.click(await screen.findByRole('button', { name: /Module installs/ }))
    expect(screen.queryByTestId('story-run-tree')).not.toBeInTheDocument()
  })

  it('opens a story as its own page with breadcrumbs, its chat beside it, and goes back to the board from them', async () => {
    renderBoard({ treeId: 't1' })
    fireEvent.click(await screen.findByRole('button', { name: /Module installs/ }))
    expect(screen.getByTestId('story-page')).toHaveTextContent('Module installs')
    expect(screen.queryByRole('region', { name: 'Delivery instructions' })).not.toBeInTheDocument()
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Shop', 'Delivery instructions', 'The field', 'Module installs'])
    expect(within(crumbs).getByText('Module installs')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('item-chat')).toHaveTextContent('story l1')
    fireEvent.click(screen.getByRole('tab', { name: 'Channel' }))
    expect(screen.getByTestId('channel')).toHaveTextContent('p1')
    fireEvent.click(screen.getByRole('tab', { name: 'Story chat' }))
    expect(screen.getByTestId('item-chat')).toHaveTextContent('story l1')
    fireEvent.click(within(crumbs).getByRole('button', { name: 'Shop' }))
    expect(await screen.findByRole('region', { name: 'Delivery instructions' })).toBeInTheDocument()
    expect(screen.getByTestId('channel')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Story chat' })).not.toBeInTheDocument()
  })

  it('opens on a story a link pointed at, and lists the threads that open beside it', async () => {
    renderBoard({ treeId: 't1', initialBranchId: 'b1', initialLeafId: 'l2' })
    expect(await screen.findByTestId('leaf-detail')).toHaveTextContent('Browser spec')
    fireEvent.click(screen.getByRole('tab', { name: 'Threads' }))
    fireEvent.click(screen.getByRole('button', { name: 'a thread' }))
    expect(screen.getByTestId('chat')).toHaveTextContent('conv-1')
    fireEvent.click(screen.getByRole('button', { name: '← Threads' }))
    expect(screen.getByRole('button', { name: 'a thread' })).toBeInTheDocument()
  })

  it('keeps a link to a story in the address while the board is still loading it', async () => {
    window.history.replaceState(null, '', '#/projects/tree/t1/b1/l2')
    const replaced = vi.spyOn(window.history, 'replaceState')
    const pushed = vi.spyOn(window.history, 'pushState')
    const leaves = await groveApi.listLeaves()
    let release = () => {}
    vi.mocked(groveApi.listLeaves).mockImplementation(() => new Promise((resolve) => { release = () => resolve(leaves) }))
    renderBoard({ treeId: 't1', initialBranchId: 'b1', initialLeafId: 'l2' })
    await waitFor(() => expect(groveApi.listTrees).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByRole('status')).toHaveTextContent('Opening the story…')
    expect(screen.queryByText('This story is no longer on the board.')).not.toBeInTheDocument()
    release()
    expect(await screen.findByTestId('story-page')).toHaveTextContent('Browser spec')
    expect([...replaced.mock.calls, ...pushed.mock.calls].map((call) => call[2])).toEqual([])
    expect(window.location.hash).toBe('#/projects/tree/t1/b1/l2')
    replaced.mockRestore()
    pushed.mockRestore()
  })

  it('collapses the chat beside the board from its handle and brings it back', async () => {
    renderBoard({ treeId: 't1' })
    await screen.findByTestId('channel')
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize the chat panel' }))
    expect(screen.queryByRole('separator', { name: 'Resize the chat panel' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand right panel' }))
    expect(screen.getByRole('separator', { name: 'Resize the chat panel' })).toBeInTheDocument()
  })

  it('offers to plan the work of a project that has none yet', async () => {
    vi.mocked(groveApi.listTrees).mockResolvedValue([] as never)
    vi.mocked(chatPackApi.createChatConversation).mockResolvedValue({ id: 'conv-new', title: 'New conversation', projectId: 'p1' })
    renderBoard({ projectId: 'p1' })
    fireEvent.click(await screen.findByRole('button', { name: 'Start a conversation' }))
    await waitFor(() => expect(chatPackApi.createChatConversation).toHaveBeenCalledWith('New conversation', { projectId: 'p1' }))
    expect(await screen.findByTestId('chat')).toHaveTextContent('conv-new')
  })

  it('opens a feature as its own page with only its stories, and a story from there', async () => {
    renderBoard({ treeId: 't1' })
    fireEvent.click(await screen.findByRole('button', { name: 'The field' }))
    const page = screen.getByTestId('feature-page')
    expect(within(page).getByRole('heading', { name: 'The field' })).toBeInTheDocument()
    expect(within(page).getByText('2 stories · 1 verified · 0 failed')).toBeInTheDocument()
    expect(within(page).getAllByTestId('story-card')).toHaveLength(2)
    expect(screen.getByTestId('item-chat')).toHaveTextContent('feature b1')
    fireEvent.click(within(page).getByRole('button', { name: /Browser spec/ }))
    expect(screen.getByTestId('story-page')).toHaveTextContent('Browser spec')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', { name: 'The field' }))
    expect(screen.getByTestId('feature-page')).toBeInTheDocument()
  })

  it('moves a feature down the board and saves the new order of the epic\'s features', async () => {
    let branches = [{ id: 'b1', title: 'The field', treeId: 't1', priority: 0 }, { id: 'b2', title: 'The proof', treeId: 't1', priority: 1 }]
    vi.mocked(groveApi.listBranches).mockImplementation(async () => branches as never)
    vi.mocked(groveApi.orderFeatures).mockImplementation(async (_treeId, order) => { branches = branches.map((branch) => ({ ...branch, priority: order.indexOf(branch.id) })) })
    renderBoard({ treeId: 't1' })
    const epic = await screen.findByRole('region', { name: 'Delivery instructions' })
    await within(epic).findByRole('row', { name: /The proof/ })
    expect(within(epic).getByRole('button', { name: 'Move “The field” up' })).toBeDisabled()
    fireEvent.click(within(epic).getByRole('button', { name: 'Move “The field” down' }))
    await waitFor(() => expect(groveApi.orderFeatures).toHaveBeenCalledWith('t1', ['b2', 'b1']))
    await waitFor(() => expect(within(epic).getAllByTestId('feature-lane').map((lane) => lane.textContent?.slice(0, 9))).toEqual(['The proof', 'The field']))
  })

  it('gives each card of a column with more than one a handle to drag it by', async () => {
    vi.mocked(groveApi.listLeaves).mockResolvedValue([
      { id: 'l1', branchId: 'b1', title: 'Module installs', status: 'pending', updatedAt: 't' },
      { id: 'l3', branchId: 'b1', title: 'Report prints', status: 'pending', updatedAt: 't' },
    ] as never)
    renderBoard({ treeId: 't1' })
    expect(await screen.findByRole('button', { name: 'Move “Module installs”' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move “Report prints”' })).toBeInTheDocument()
  })
})
