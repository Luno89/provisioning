import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import RootAdmin from './RootAdmin'
import { api } from '../../../api/client'

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return { ...original, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }
})

const PEOPLE = [
  { id: 'ana', email: 'ana@example.com', isAdmin: true, createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'bob', email: 'bob@example.com', isAdmin: false, createdAt: '2026-10-01T00:00:00.000Z', instance: { name: 'bob', where: 'pool', status: 'ready', url: 'https://bob.koala.dev', trialEndsAt: '2026-11-03T12:00:00.000Z' } },
  { id: 'cy', email: 'cy@example.com', isAdmin: false, createdAt: '2026-10-02T00:00:00.000Z', instance: { name: 'cy', where: 'own', status: 'ready', url: 'https://cy.koala.dev', version: 'v2026.10.25', autoUpdates: false } },
  { id: 'di', email: 'di@example.com', isAdmin: false, createdAt: '2026-10-03T00:00:00.000Z', removal: { startedAt: 'now', requestedBy: 'ana', state: { state: 'running', done: ['instance'] }, steps: ['instance', 'mesh', 'records'] } },
]

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><RootAdmin onLogout={() => {}} /></QueryClientProvider>)
}

describe('root\'s admin area', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/admin/people') return { data: { people: PEOPLE } }
      if (url === '/admin/people/bob/removal') return { data: { email: 'bob@example.com', blockers: [] } }
      if (url === '/admin/invites') return { data: [{ id: 'c1', createdBy: 'ana', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z', expired: true }] }
      if (url === '/instances/pool/admin') return { data: { slots: 4, trialDays: 14, defaultTrialDays: 14, instances: [] } }
      throw new Error(`unexpected ${url}`)
    })
    vi.mocked(api.post).mockResolvedValue({ data: { id: 'c2', code: 'efgh5678', createdBy: 'ana', createdAt: '2026-10-20T00:00:00.000Z', expiresAt: '2026-11-03T00:00:00.000Z', expired: false } })
    vi.mocked(api.delete).mockResolvedValue({ data: { state: { state: 'running', done: [] } } })
  })

  it('lists every account with where its instance runs, root\'s removal progress, the invites and Koala\'s servers', async () => {
    renderPage()
    expect(await screen.findByTestId('instance-bob')).toHaveTextContent('bob on Koala\'s servers: running, trial ends')
    expect(screen.getByTestId('instance-cy')).toHaveTextContent('cy on their own machine: running v2026.10.25, updates by hand')
    expect(screen.getByText('removing its machines from the mesh (2 of 3)')).toBeInTheDocument()
    expect(await screen.findByText('Expired')).toBeInTheDocument()
    expect(screen.queryByText('abcd1234')).toBeNull()
    expect(await screen.findByText('0 of 4 places in use.')).toBeInTheDocument()
  })

  it('says a pool instance goes with the account before removing it', async () => {
    renderPage()
    await screen.findByTestId('instance-bob')
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove…' })[1]!)
    expect(await screen.findByText(/Their instance bob on Koala's servers is deleted with everything in it/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bob@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/people/bob', { data: { confirm: 'bob@example.com' } }))
  })

  it('makes an invite', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Generate invite' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/invites', {}))
    expect(await screen.findByTestId('new-invite')).toHaveTextContent('efgh5678')
    expect(screen.getByTestId('new-invite')).toHaveTextContent('It will not be shown again.')
  })
})
