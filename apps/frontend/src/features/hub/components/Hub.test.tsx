import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import * as hubApi from '../api'
import SharedProjectPage from './SharedProjectPage'
import JoinPage from './JoinPage'
import type { SharedProjectView } from '../types'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof hubApi>()),
  getSharedProject: vi.fn(),
  inviteToProject: vi.fn(),
  takeInviteBack: vi.fn(async (_id: string, email: string) => ({ email })),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(async (_id: string, personId: string) => ({ removed: personId })),
  deleteSharedProject: vi.fn(async (id: string) => ({ deleted: id })),
  getInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
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

  it('shows everyone on the project the group its apps are addressed under', async () => {
    api.getSharedProject.mockResolvedValue({ ...asOwner, project: { ...shop, group: 'acme' } })
    wrap(<SharedProjectPage id="p1" me="ann" />)
    expect((await screen.findByTestId('shared-group')).textContent).toBe('Its apps are addressed under the group acme, as <app>-acme.')
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

  it('keeps whoever shared it from their instance an owner, with no way for another owner to change or remove them', async () => {
    const shared = { ...asOwner, project: { ...shop, origin: { instanceId: 'i-ann', projectId: 'x' } }, members: [...asOwner.members!, { personId: 'bo', email: 'bo@example.com', role: 'owner' as const, joinedAt: 't' }] }
    api.getSharedProject.mockResolvedValue(shared)
    const { unmount } = wrap(<SharedProjectPage id="p1" me="bo" />)
    expect(await screen.findByText('Owner · shared it')).toBeTruthy()
    expect(screen.queryByLabelText('What ann@example.com may do')).toBeNull()
    expect(screen.queryByLabelText('Remove ann@example.com')).toBeNull()
    expect(screen.getByLabelText('What cy@example.com may do')).toBeTruthy()
    expect(screen.getByText('Leave this project')).toBeTruthy()
    unmount()

    wrap(<SharedProjectPage id="p1" me="ann" />)
    expect(await screen.findByText(/take it back there, in the project's Settings → People/)).toBeTruthy()
    expect(screen.queryByText('Leave this project')).toBeNull()
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
