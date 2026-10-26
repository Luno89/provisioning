import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import * as hubApi from '../api'
import HubProjectPage from './HubProjectPage'
import type { HubBoardView } from '../types'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
  useNavigate: () => vi.fn(),
  useRouter: () => undefined,
}))

vi.mock('../../files/components/StoredFiles', () => ({ default: ({ rearranges }: { rearranges?: boolean }) => <div data-testid="stored-files">{rearranges ? 'rearranges' : 'adds only'}</div> }))
vi.mock('../../projects/components/LeafDetail', () => ({ default: ({ leaf }: { leaf: { title: string } }) => <div data-testid="leaf-detail">{leaf.title}</div> }))
vi.mock('./HubRepository', () => ({ default: () => <div data-testid="hub-repository" /> }))

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof hubApi>()),
  getHubBoard: vi.fn(),
  getHubConversation: vi.fn(),
  postHubMessage: vi.fn(),
  sendHubRequest: vi.fn(),
  getSharedProject: vi.fn(),
}))

const api = vi.mocked(hubApi)

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

const proposal = {
  id: 'pp1',
  ownerId: 'ann',
  conversationId: 'ch1',
  status: 'proposed',
  plan: {
    tree: { name: 'Widget API', type: 'api-service' },
    planDoc: '# Widget API',
    branches: [{ title: 'Operability', leaves: [{ key: 'health', title: 'Health endpoint', body: 'b', brief: 'b', dependsOn: [], tasks: [] }] }],
  },
  createdAt: 'now',
  updatedAt: 'now',
}

const view = (over: Partial<HubBoardView> = {}): HubBoardView => ({
  project: { id: 'h1', name: 'Shop', createdAt: 't', createdBy: 'ann', origin: { projectId: 'p1' } },
  role: 'collaborator',
  can: ['see-project', 'see-people', 'change-files', 'approve-changes', 'work-stories', 'pin-and-comment', 'ask-koala'],
  online: true,
  members: [{ personId: 'ann', email: 'ann@example.com', role: 'owner' }, { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }],
  board: {
    trees: [{ id: 't1', name: 'Delivery', projectIds: ['p1'] }],
    branches: [{ id: 'b1', title: 'The field', treeId: 't1' }],
    leaves: [
      { id: 'l1', branchId: 'b1', title: 'Module installs', status: 'succeeded', verified: true, updatedAt: '2026-10-09T00:00:00Z' },
      { id: 'l2', branchId: 'b1', title: 'Browser spec', status: 'running', updatedAt: '2026-10-09T00:00:00Z' },
    ],
    tasks: [],
    planProposals: [proposal],
  },
  chats: [{ id: 'ch1', title: 'Shop', kind: 'channel' }],
  requests: [],
  ...over,
} as unknown as HubBoardView)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api.getHubConversation.mockResolvedValue({ id: 'ch1', title: 'Shop', kind: 'channel', messages: [{ role: 'user', content: 'hello there', authorName: 'ann@example.com' }] } as never)
  api.sendHubRequest.mockResolvedValue({} as never)
  api.postHubMessage.mockResolvedValue({ message: { role: 'user', content: 'x' } } as never)
})

describe('a shared project on the hub', () => {
  it('shows a client the board, the plan card without a say, the repository and every file, which they add to but do not move or remove', async () => {
    api.getHubBoard.mockResolvedValue(view({ role: 'client', can: ['see-project', 'see-people', 'pin-and-comment', 'ask-koala'] }))
    wrap(<HubProjectPage id="h1" me="cy" />)
    expect(await screen.findByText('Browser spec')).toBeTruthy()
    expect(screen.getByText('Module installs')).toBeTruthy()
    expect(await screen.findByText('An owner or a collaborator decides this.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    fireEvent.click(screen.getByText('Browser spec'))
    await screen.findByTestId('story-page')
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(screen.getByTestId('hub-repository')).toBeTruthy()
    expect(screen.getByTestId('stored-files').textContent).toBe('adds only')
  })

  it('lets a collaborator approve a plan, which then reads as waiting on the owner\'s instance', async () => {
    api.getHubBoard.mockResolvedValue(view())
    api.sendHubRequest.mockImplementation(async () => {
      api.getHubBoard.mockResolvedValue(view({ requests: [{ id: 'r1', kind: 'approve-plan', input: { proposalId: 'pp1' }, by: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' }, at: 't', state: 'waiting' }] }))
      return {} as never
    })
    wrap(<HubProjectPage id="h1" me="bo" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.sendHubRequest).toHaveBeenCalledWith('h1', 'approve-plan', { proposalId: 'pp1' }))
    await waitFor(() => expect(screen.getAllByText(/approval is on its way to ann@example.com's instance/).length).toBeGreaterThan(0))
    expect(within(screen.getByTestId('plan-waiting')).getByText(/on its way/)).toBeTruthy()
  })

  it('posts in the channel to Koala when Ask Koala is on', async () => {
    api.getHubBoard.mockResolvedValue(view({ role: 'owner', can: ['see-project', 'see-people', 'change-files', 'approve-changes', 'invite'] }))
    wrap(<HubProjectPage id="h1" me="ann" />)
    await screen.findByText('hello there')
    fireEvent.click(screen.getByRole('button', { name: /Ask Koala: off/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'what is next?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.postHubMessage).toHaveBeenCalledWith('h1', 'ch1', { content: 'what is next?', askKoala: true }))
  })

  it('tells a collaborator Koala answers from their own instance, and offers no Ask Koala switch', async () => {
    api.getHubBoard.mockResolvedValue(view())
    wrap(<HubProjectPage id="h1" me="bo" />)
    await screen.findByText('hello there')
    expect(screen.getByText(/Koala answers you from your own instance/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ask Koala: off/ })).toBeNull()
  })

  it('asks the owner\'s instance to open a story chat that is not on the hub yet', async () => {
    api.getHubBoard.mockResolvedValue(view())
    wrap(<HubProjectPage id="h1" me="bo" />)
    fireEvent.click(await screen.findByText('Browser spec'))
    await waitFor(() => expect(api.sendHubRequest).toHaveBeenCalledWith('h1', 'open-chat', { item: 'story', id: 'l2' }))
    expect(await screen.findByText('Opening the chat…')).toBeTruthy()
  })

  it('says when the owner\'s instance is offline', async () => {
    api.getHubBoard.mockResolvedValue(view({ online: false }))
    wrap(<HubProjectPage id="h1" me="bo" />)
    expect((await screen.findByTestId('hub-offline')).textContent).toContain('Offline: the owner\'s instance is not connected')
    expect((await screen.findByTestId('hub-offline-chat')).textContent).toContain('Koala answers when it is back')
  })
})
