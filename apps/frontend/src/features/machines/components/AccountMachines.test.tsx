import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MACHINE_JOINS_CHANGED } from '@koala/engine-core/machine-join'
import AccountMachines from './AccountMachines'
import type { AccountMachine, MachineJoinView } from '../api'
import { api } from '../../../api/client'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }))
vi.mock('../../platform/stores/socket', () => ({
  useSocketEvent: (event: string, handler: () => void) => { handlers.set(event, handler) },
}))

vi.mock('../../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../api/client')>()
  return { ...original, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }
})

const later = '2099-01-01T00:00:00.000Z'
const join = (overrides: Partial<MachineJoinView> = {}): MachineJoinView => ({
  id: 'j1', stage: 'k3s', title: 'Installing k3s', state: 'started', at: '2026-11-18T10:00:00.000Z', expiresAt: later, joined: false, ...overrides,
})

const showing = (joins: MachineJoinView[], machines: AccountMachine[] = []) =>
  vi.mocked(api.get).mockResolvedValue({ data: { machines, joins, koala: null } })

const machine = (over: Partial<AccountMachine> = {}): AccountMachine => ({
  id: 'desk', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-11-01T00:00:00Z', meshIp: '100.64.0.7', online: true, koalaWanted: false, holdsKoala: false, ...over,
})

const renderPanel = (hasKoala = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AccountMachines name="bobby" nameOk hasKoala={hasKoala} onPlacing={() => undefined} />
    </QueryClientProvider>,
  )
}

describe('a person\'s machines at root', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says why Koala could not be put on a machine, and Try again asks again', async () => {
    showing([], [machine({ koalaRefused: { reason: '"bobby" is taken', at: '2026-11-17T10:00:00Z' } })])
    vi.mocked(api.post).mockResolvedValue({ data: { placing: false } })
    renderPanel(false)
    expect(await screen.findByText('Koala could not be put here: "bobby" is taken')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/my-machines/desk/koala', { name: 'bobby' }))
  })

  it('says a machine\'s token could not be renewed, why, and when it stops working unless it is', async () => {
    showing([], [machine({ tokenRenewal: { reason: 'the machine did not keep its new token', failedAt: '2026-11-17T10:00:00Z', stopsAt: '2026-12-01T00:00:00Z' } })])
    renderPanel()
    const line = await screen.findByText(/^Its token could not be renewed: the machine did not keep its new token; it stops working on /)
    expect(line.textContent).toContain(new Date('2026-12-01T00:00:00Z').toLocaleDateString())
    expect(line.textContent).toMatch(/unless it is$/)
  })

  it('says nothing of either when nothing went wrong', async () => {
    showing([], [machine()])
    renderPanel()
    await screen.findByText('desk')
    expect(screen.queryByText(/could not be put here/)).toBeNull()
    expect(screen.queryByText(/could not be renewed/)).toBeNull()
  })
})

describe('My Machines on root, while a machine joins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
  })

  it('shows a join in progress with the stage it is on, and offers no dismissal', async () => {
    showing([join()])
    renderPanel()
    expect(await screen.findByText('Installing k3s')).toBeDefined()
    expect(screen.getByText(/joining/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull()
  })

  it('shows a failed join with where and why it failed, until the person dismisses it', async () => {
    showing([join({ state: 'failed', why: 'the k3s downloaded is not the one Koala pins' })])
    vi.mocked(api.delete).mockResolvedValue({ data: { dismissed: true } })
    renderPanel()
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText(/Installing k3s/)).toBeDefined()
    expect(screen.getByText('the k3s downloaded is not the one Koala pins')).toBeDefined()
    expect(screen.getByText(/run the command again/i)).toBeDefined()
    showing([])
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/my-machines/joins/j1'))
    await waitFor(() => expect(screen.queryByText('the k3s downloaded is not the one Koala pins')).toBeNull())
  })

  it('says a join whose command expired before it finished can no longer report, and lets it be dismissed', async () => {
    showing([join({ state: 'done', expiresAt: '2026-01-01T00:00:00.000Z' })])
    renderPanel()
    expect(await screen.findByText(/stopped reporting/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeDefined()
  })

  it('lets the person dismiss a join a machine joined with, which has no deadline, past its command\'s hour', async () => {
    showing([join({ joined: true, expiresAt: '2026-01-01T00:00:00.000Z' })])
    vi.mocked(api.delete).mockResolvedValue({ data: { dismissed: true } })
    renderPanel()
    expect(await screen.findByText('Installing k3s')).toBeDefined()
    expect(screen.queryByText(/stopped reporting/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/my-machines/joins/j1'))
  })

  it('follows the join live as root says it changed', async () => {
    showing([join()])
    renderPanel()
    expect(await screen.findByText('Installing k3s')).toBeDefined()
    showing([join({ stage: 'agent', title: 'Installing the machine agent' })])
    handlers.get(MACHINE_JOINS_CHANGED)!()
    expect(await screen.findByText('Installing the machine agent')).toBeDefined()
  })
})
