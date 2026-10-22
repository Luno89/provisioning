import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import * as hubApi from '../../api/hub'
import ShareProject from './ShareProject'
import type { GroupCheck, SharingPreview } from '../../types/hub'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('../../lib/use-debounce', () => ({ DEBOUNCE_MS: 0, useDebounce: <T,>(value: T) => value }))

vi.mock('../../api/hub', async (orig) => ({
  ...(await orig<typeof hubApi>()),
  getSharing: vi.fn(),
  shareProject: vi.fn(),
  takeProjectBack: vi.fn(),
  checkGroup: vi.fn(),
}))

const api = vi.mocked(hubApi)

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

const unshared: SharingPreview = { canShare: true, addresses: { scope: 'owner' }, moves: { epics: 1, features: 2, stories: 5, tasks: 3, chats: 4, repository: 'shop' }, stays: ['the project\'s secrets'] }
const sharedAs = (group?: string): SharingPreview => ({
  ...unshared,
  shared: { hubProjectId: 'h1', sharedAt: 't' },
  ...(group ? { group, addresses: { scope: 'group' as const, example: `shop-${group}.koala.dev` } } : {}),
})

const groupRules = async (_projectId: string, name: string): Promise<GroupCheck> => {
  if (!name) return { ok: false, suggested: 'shop' }
  if (name.includes('-')) return { ok: false, problem: 'a name has no dashes', suggested: 'shop' }
  if (name === 'taken') return { ok: false, problem: '"taken" is taken', suggested: 'shop' }
  return { ok: true, suggested: 'shop', example: `shop-${name}.koala.dev` }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.checkGroup.mockImplementation(groupRules)
})

describe('sharing a project from its settings', () => {
  it('says what goes and what stays before sharing, and shares only when asked, under the group suggested', async () => {
    api.getSharing.mockResolvedValue(unshared)
    api.shareProject.mockResolvedValue(sharedAs('shop'))
    wrap(<ShareProject project={{ id: 'p1', name: 'Shop' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Share this project…' }))
    const confirm = screen.getByTestId('share-confirm').textContent ?? ''
    expect(confirm).toContain('1 epic, 2 features, 5 stories, 3 tasks')
    expect(confirm).toContain('the repository shop')
    expect(confirm).toContain('the project\'s secrets')
    await waitFor(() => expect((screen.getByLabelText('The group its apps are addressed under') as HTMLInputElement).value).toBe('shop'))
    expect((await screen.findByTestId('share-address')).textContent).toContain('Its apps will be addressed shop-shop.koala.dev.')
    expect(api.shareProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Share Shop' }))
    await waitFor(() => expect(api.shareProject).toHaveBeenCalledWith('p1', 'shop'))
    expect((await screen.findByTestId('share-group')).textContent).toContain('addressed under the group shop, as shop-shop.koala.dev. The group stays as it is while the project is shared')
  })

  it('checks the group as it is typed, says what is wrong with it, and holds Share until it is fine', async () => {
    api.getSharing.mockResolvedValue(unshared)
    api.shareProject.mockResolvedValue(sharedAs('acme'))
    wrap(<ShareProject project={{ id: 'p1', name: 'Shop' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Share this project…' }))
    const field = await screen.findByLabelText('The group its apps are addressed under')
    const share = screen.getByRole('button', { name: 'Share Shop' }) as HTMLButtonElement

    fireEvent.change(field, { target: { value: 'Ac-Me' } })
    expect((await screen.findByRole('alert')).textContent).toBe('a name has no dashes')
    expect(share.disabled).toBe(true)
    expect(api.checkGroup).toHaveBeenCalledWith('p1', 'ac-me')

    fireEvent.change(field, { target: { value: 'taken' } })
    expect((await screen.findByRole('alert')).textContent).toBe('"taken" is taken')
    expect(share.disabled).toBe(true)

    fireEvent.change(field, { target: { value: 'acme' } })
    await waitFor(() => expect(share.disabled).toBe(false))
    expect(screen.getByTestId('share-address').textContent).toContain('shop-acme.koala.dev')
    fireEvent.click(share)
    await waitFor(() => expect(api.shareProject).toHaveBeenCalledWith('p1', 'acme'))
  })

  it('names the group alone where there is no domain to show an address under', async () => {
    api.getSharing.mockResolvedValue(unshared)
    api.checkGroup.mockImplementation(async (_id, name) => (name ? { ok: true, suggested: 'shop' } : { ok: false, suggested: 'shop' }))
    wrap(<ShareProject project={{ id: 'p1', name: 'Shop' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Share this project…' }))
    expect((await screen.findByTestId('share-address')).textContent).toContain('Its apps will be addressed under the group shop.')
  })

  it('says a project shared before groups keeps its owner\'s addresses', async () => {
    api.getSharing.mockResolvedValue(sharedAs())
    wrap(<ShareProject project={{ id: 'p1', name: 'Shop' }} />)
    expect((await screen.findByTestId('share-group')).textContent).toContain('keep your own addresses')
  })

  it('says sharing needs a hub where there is none, and offers nothing to press', async () => {
    api.getSharing.mockResolvedValue({ ...unshared, canShare: false })
    wrap(<ShareProject project={{ id: 'p1', name: 'Shop' }} />)
    expect((await screen.findByTestId('share-project')).textContent).toContain('needs a hub')
    expect(screen.queryByRole('button')).toBeNull()
    expect(api.checkGroup).not.toHaveBeenCalled()
  })

  it('takes it back only once its name is typed', async () => {
    api.getSharing.mockResolvedValue(sharedAs('acme'))
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
