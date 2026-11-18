import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PROVISION_PIECES, PROVISIONING_CHANGED, type ProvisioningView, type ProvisionPieceView } from '@koala/engine-core/koala-install'
import { ProvisioningCard } from './ProvisioningCard'
import type { ProvisioningAnswer } from '../api/provisioning'
import { api } from '../../../api/client'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }))
vi.mock('../../platform/stores/socket', () => ({
  useSocketEvent: (event: string, handler: () => void) => { handlers.set(event, handler) },
}))

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return { ...original, api: { get: vi.fn(), post: vi.fn() } }
})

const pieces = (change: (piece: ProvisionPieceView, index: number) => ProvisionPieceView = (piece) => piece): ProvisionPieceView[] =>
  PROVISION_PIECES.map((piece, index) => change({ key: piece.key, title: piece.title, state: 'waiting' }, index))

const setup = (over: Partial<ProvisioningView> = {}): ProvisioningView => ({
  id: 'provision-desk~1', target: { kind: 'koala', clusterId: 'desk' }, revision: 7, reason: 'revision', state: 'running', pieces: pieces(), startedAt: '2026-11-18T10:00:00.000Z', ...over,
})

const answering = (answer: ProvisioningAnswer) => vi.mocked(api.get).mockResolvedValue({ data: answer })

const renderCard = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ProvisioningCard /></QueryClientProvider>)
}

describe('the "Setting Koala up" card on Infrastructure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
  })

  it('lists each piece with its state and follows the setup live as Koala says it changed', async () => {
    answering({ setups: [setup({ pieces: pieces((piece, index) => (index === 0 ? { ...piece, state: 'working', line: 'waiting for deployment/egress in egress: 0 of 1 ready' } : piece)) })], can: ['set-up-again'] })
    renderCard()
    expect(await screen.findByText('waiting for deployment/egress in egress: 0 of 1 ready')).toBeDefined()
    expect(screen.getByText('Setting Koala up')).toBeDefined()
    expect(screen.getAllByText('waiting its turn')).toHaveLength(6)
    expect(screen.queryByRole('button', { name: 'Set up again' })).toBeNull()
    answering({ setups: [setup({ pieces: pieces((piece, index) => (index === 0 ? { ...piece, state: 'up' } : index === 1 ? { ...piece, state: 'working', line: 'waiting for deployment/searxng in searxng: 0 of 1 ready' } : piece)) })], can: ['set-up-again'] })
    handlers.get(PROVISIONING_CHANGED)!()
    expect(await screen.findByText('waiting for deployment/searxng in searxng: 0 of 1 ready')).toBeDefined()
    expect(screen.getByText('The egress proxy').closest('li')?.textContent).toContain('up')
  })

  it('shows where the setup stopped and why, and "Set up again" asks for the same setup again', async () => {
    const failed = setup({ state: 'failed', why: 'Gitea, your repositories and images: pod gitea-0 is Init:Error', pieces: pieces((piece, index) => (index < 3 ? { ...piece, state: 'up' } : index === 3 ? { ...piece, state: 'failed', why: 'pod gitea-0 is Init:Error' } : piece)) })
    answering({ setups: [failed], can: ['set-up-again'] })
    vi.mocked(api.post).mockResolvedValue({ data: setup({ id: 'provision-desk~2', reason: 'asked' }) })
    renderCard()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Stopped at Gitea, your repositories and images: pod gitea-0 is Init:Error')
    expect(screen.getByText('pod gitea-0 is Init:Error')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Set up again' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/infrastructure/provisioning/again', { clusterId: 'desk' }))
  })

  it('offers "Set up again" to nobody the answer does not allow it', async () => {
    answering({ setups: [setup({ state: 'failed', why: 'Monitoring: helm said no', pieces: pieces((piece, index) => (index === 6 ? { ...piece, state: 'failed', why: 'helm said no' } : { ...piece, state: 'up' })) })], can: [] })
    renderCard()
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Set up again' })).toBeNull()
  })

  it('says why "Set up again" was refused', async () => {
    answering({ setups: [setup({ state: 'failed', why: 'Monitoring: helm said no', pieces: pieces((piece, index) => (index === 6 ? { ...piece, state: 'failed', why: 'helm said no' } : { ...piece, state: 'up' })) })], can: ['set-up-again'] })
    vi.mocked(api.post).mockRejectedValue(Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 503, data: { error: 'Temporal is not reachable, so Koala cannot set itself up' } } }))
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Set up again' }))
    expect(await screen.findByText('Temporal is not reachable, so Koala cannot set itself up')).toBeDefined()
  })

  it('collapses to one line once everything is up', async () => {
    answering({ setups: [setup({ state: 'up', pieces: pieces((piece) => ({ ...piece, state: 'up' })), endedAt: '2026-11-18T10:20:00.000Z' })], can: ['set-up-again'] })
    renderCard()
    expect(await screen.findByText('Koala\'s services and monitoring are set up (revision 7).')).toBeDefined()
    expect(screen.queryByText('The egress proxy')).toBeNull()
  })

  it('says why it cannot show the setup when the answer fails', async () => {
    vi.mocked(api.get).mockRejectedValue(Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 500, data: { error: 'the provisioning records could not be read' } } }))
    renderCard()
    expect(await screen.findByText('the provisioning records could not be read')).toBeDefined()
  })
})
