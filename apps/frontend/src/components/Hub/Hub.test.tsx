import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import * as hubApi from '../../api/hub'
import SharedProjectPage from './SharedProjectPage'
import JoinPage from './JoinPage'
import ShareProject from './ShareProject'
import type { SharedProjectView } from '../../types/hub'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

vi.mock('../../api/hub', async (orig) => ({
  ...(await orig<typeof hubApi>()),
  getSharedProject: vi.fn(),
  inviteToProject: vi.fn(),
  takeInviteBack: vi.fn(async (_id: string, email: string) => ({ email })),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(async (_id: string, personId: string) => ({ removed: personId })),
  deleteSharedProject: vi.fn(async (id: string) => ({ deleted: id })),
  getInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  getSharing: vi.fn(),
  shareProject: vi.fn(),
  takeProjectBack: vi.fn(),
}))

const api = vi.mocked(hubApi)

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

const shop = { id: 'p1', name: 'Shop', createdAt: 't', createdBy: 'ann' }
const asOwner: SharedProjectView = {
  project: shop,
  role: 'owner',
  can: ['see-project', 'see-people', 'invite', 'change-roles', 'remove-people', 'change-settings'],
  members: [{ personId: 'ann', email: 'ann@example.com', role: 'owner', joinedAt: 't' }, { personId: 'cy', email: 'cy@example.com', role: 'client', joinedAt: 't' }],
  invites: [{ projectId: 'p1', email: 'bo@example.com', role: 'collaborator', invitedBy: 'ann', createdAt: 't' }],
}

beforeEach(() => vi.clearAllMocks())

describe('a shared project\'s people', () => {
  it('lets an owner invite by email with a role, and shows the link to send when root emailed nothing', async () => {
    api.getSharedProject.mockResolvedValue(asOwner)
    api.inviteToProject.mockResolvedValue({ email: 'dee@example.com', role: 'collaborator', link: 'http://root/#/join?code=C&project=J', emailed: false, why: 'this root sends no email' })
    wrap(<SharedProjectPage id="p1" me="ann" />)
    expect(await screen.findByText('bo@example.com · Collaborator · invited, not joined yet')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Their email address'), { target: { value: 'dee@example.com' } })
    fireEvent.change(screen.getByLabelText('What they may do'), { target: { value: 'collaborator' } })
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }))
    await waitFor(() => expect(api.inviteToProject).toHaveBeenCalledWith('p1', { email: 'dee@example.com', role: 'collaborator' }))
    expect(((await screen.findByLabelText('The invite link')) as HTMLInputElement).value).toBe('http://root/#/join?code=C&project=J')
    expect(screen.getByTestId('invite-sent').textContent).toContain('this root sends no email')
  })

  it('lets an owner change a role, remove someone, and delete only once the name is typed', async () => {
    api.getSharedProject.mockResolvedValue(asOwner)
    api.changeMemberRole.mockResolvedValue(asOwner)
    const left = vi.fn()
    wrap(<SharedProjectPage id="p1" me="ann" onLeft={left} />)
    fireEvent.change(await screen.findByLabelText('What cy@example.com may do'), { target: { value: 'collaborator' } })
    await waitFor(() => expect(api.changeMemberRole).toHaveBeenCalledWith('p1', 'cy', 'collaborator'))
    fireEvent.click(screen.getByLabelText('Remove cy@example.com'))
    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith('p1', 'cy'))
    expect(screen.queryByLabelText('Remove ann@example.com')).toBeNull()

    const remove = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('The project\'s name, to delete it'), { target: { value: 'Shop' } })
    fireEvent.click(remove)
    await waitFor(() => expect(api.deleteSharedProject).toHaveBeenCalledWith('p1', 'Shop'))
    await waitFor(() => expect(left).toHaveBeenCalled())
  })

  it('shows a client the people and nothing to invite, change or delete with', async () => {
    api.getSharedProject.mockResolvedValue({ project: shop, role: 'client', can: ['see-project', 'see-people', 'pin-and-comment', 'ask-koala'], members: asOwner.members! })
    wrap(<SharedProjectPage id="p1" me="cy" />)
    expect(await screen.findByText('ann@example.com')).toBeTruthy()
    expect(screen.queryByLabelText('Their email address')).toBeNull()
    expect(screen.queryByLabelText('What ann@example.com may do')).toBeNull()
    expect(screen.queryByText('Delete this shared project')).toBeNull()
    expect(screen.getByText('Leave this project')).toBeTruthy()
  })
})

describe('taking an invite', () => {
  it('joins when it is for you, and says whose it is when it is not', async () => {
    api.getInvitation.mockResolvedValueOnce({ projectName: 'Shop', role: 'client', email: 'cy@example.com', forYou: true })
    api.acceptInvitation.mockResolvedValue({ ...asOwner, role: 'client' })
    const joined = vi.fn()
    const { unmount } = wrap(<JoinPage token="T" me="cy@example.com" onJoined={joined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Join Shop' }))
    await waitFor(() => expect(joined).toHaveBeenCalledWith('p1'))
    unmount()

    api.getInvitation.mockResolvedValueOnce({ projectName: 'Shop', role: 'client', email: 'cy@example.com', forYou: false })
    wrap(<JoinPage token="T" me="eve@example.com" onJoined={joined} />)
    expect(await screen.findByText(/This invite is for cy@example.com, and you are signed in as eve@example.com/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Join Shop' })).toBeNull()
  })
})

describe('sharing a project from its settings', () => {
  const unshared = { moves: { epics: 1, features: 2, stories: 5, tasks: 3, chats: 4, repository: 'shop' }, stays: ['the project\'s secrets'] }

  it('says what goes and what stays before sharing, and shares only when asked', async () => {
    api.getSharing.mockResolvedValue(unshared)
    api.shareProject.mockResolvedValue({ ...unshared, shared: { hubProjectId: 'h1', sharedAt: 't' } })
    wrap(<ShareProject project={{ id: 'p1', name: 'Shop' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Share this project…' }))
    const confirm = screen.getByTestId('share-confirm').textContent ?? ''
    expect(confirm).toContain('1 epic, 2 features, 5 stories, 3 tasks')
    expect(confirm).toContain('the repository shop')
    expect(confirm).toContain('the project\'s secrets')
    expect(api.shareProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Share Shop' }))
    expect(await screen.findByRole('button', { name: /People on Shop/ })).toBeTruthy()
  })

  it('takes it back only once its name is typed', async () => {
    api.getSharing.mockResolvedValue({ ...unshared, shared: { hubProjectId: 'h1', sharedAt: 't' } })
    api.takeProjectBack.mockResolvedValue(unshared)
    wrap(<ShareProject project={{ id: 'p1', name: 'Shop' }} />)
    const back = await screen.findByRole('button', { name: /Take it back/ }) as HTMLButtonElement
    expect(back.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('The project\'s name, to take it back'), { target: { value: 'Shop' } })
    fireEvent.click(back)
    await waitFor(() => expect(api.takeProjectBack).toHaveBeenCalledWith('p1', 'Shop'))
    expect(await screen.findByRole('button', { name: 'Share this project…' })).toBeTruthy()
  })
})
