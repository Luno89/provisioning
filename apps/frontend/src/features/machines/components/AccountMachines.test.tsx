import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MACHINE_JOINS_CHANGED } from '@koala/engine-core/machine-join'
import { KOALA_INSTALL_CHANGED, type KoalaInstallView } from '@koala/engine-core/koala-install'
import AccountMachines from './AccountMachines'
import type { AccountMachine, MachineJoinView } from '../api'
import { api } from '../../../api/client'
import { socketHandlers as handlers } from '../../../test/socket-events'

vi.mock('../../platform/stores/socket', () => import('../../../test/socket-events'))
vi.mock('../../../api/client', async (importOriginal) => (await import('../../../test/mocked-api')).mockedApi(importOriginal, 'get', 'post', 'delete'))

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

  it('says a machine\'s key could not be replaced, why, and when it stops working unless it is', async () => {
    showing([], [machine({ keyReplacement: { reason: 'the disk was full', failedAt: '2026-11-17T10:00:00Z', stopsAt: '2026-12-01T00:00:00Z' } })])
    renderPanel()
    const line = await screen.findByText(/^Its key could not be replaced: the disk was full; it stops working on /)
    expect(line.textContent).toContain(new Date('2026-12-01T00:00:00Z').toLocaleDateString())
    expect(line.textContent).toMatch(/unless it is$/)
  })

  it('says why the person\'s machines could not be read rather than show none', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('root could not read its machines'))
    renderPanel()
    expect((await screen.findByRole('alert')).textContent).toBe('Your machines could not be read: root could not read its machines')
  })

  it('says nothing of either when nothing went wrong', async () => {
    showing([], [machine()])
    renderPanel()
    await screen.findByText('desk')
    expect(screen.queryByText(/could not be put here/)).toBeNull()
    expect(screen.queryByText(/could not be replaced/)).toBeNull()
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

  it('reads the machines again only when root says they changed, never on a timer, while a machine is being added', async () => {
    showing([])
    vi.mocked(api.post).mockResolvedValue({ data: { code: 'c1', command: 'curl -fsSL https://root.example/machine.sh | sh -s -- c1', expiresAt: later } })
    renderPanel()
    const add = await screen.findByRole('button', { name: /Add a machine/ })
    vi.useFakeTimers()
    try {
      fireEvent.click(add)
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText('curl -fsSL https://root.example/machine.sh | sh -s -- c1')).toBeDefined()
      const reads = vi.mocked(api.get).mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(vi.mocked(api.get).mock.calls.length).toBe(reads)
    } finally {
      vi.useRealTimers()
    }
    showing([], [machine({ id: 'tower', name: 'tower' })])
    handlers.get(MACHINE_JOINS_CHANGED)!()
    expect(await screen.findByText('tower')).toBeDefined()
  })
})

describe('My Machines on root, while Koala is put on a machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
  })

  const install = (over: Partial<KoalaInstallView> = {}): KoalaInstallView => ({ id: 'install-1', machineId: 'desk', state: 'installing', stage: 'koala', title: 'Putting Koala on this machine', at: '2026-11-18T10:00:00.000Z', ...over })
  const installing = (shown: KoalaInstallView, machines: AccountMachine[] = [machine({ holdsKoala: true })]) =>
    vi.mocked(api.get).mockResolvedValue({ data: { machines, joins: [], koala: { machineId: 'desk', status: shown.state === 'failed' ? 'failed' : 'installing', install: shown } } })

  it('shows the stage the machine is at and what it waits on, live as root says it changed', async () => {
    installing(install({ line: 'waiting for job/instance-seed-1 runs' }))
    renderPanel()
    expect(await screen.findByText('Putting Koala on this machine')).toBeDefined()
    expect(screen.getByText('waiting for job/instance-seed-1 runs')).toBeDefined()
    installing(install({ line: 'waiting for deployment/instance-backend has 0 of 1 available' }))
    handlers.get(KOALA_INSTALL_CHANGED)!()
    expect(await screen.findByText('waiting for deployment/instance-backend has 0 of 1 available')).toBeDefined()
  })

  it('says a machine that is offline is asked once it connects', async () => {
    const { stage: _stage, title: _title, ...asked } = install({ state: 'asked' })
    installing(asked, [machine({ holdsKoala: true, online: false })])
    renderPanel()
    expect(await screen.findByText('Koala is put on it once it connects')).toBeDefined()
  })

  it('shows where putting Koala there stopped and why, and Try again asks again', async () => {
    installing(install({ state: 'failed', why: 'job/instance-seed-1 failed: Mongo refused its password' }))
    vi.mocked(api.post).mockResolvedValue({ data: { placing: true } })
    renderPanel(false)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Koala could not be put here at Putting Koala on this machine')
    expect(screen.getByText('job/instance-seed-1 failed: Mongo refused its password')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/my-machines/desk/koala', { name: 'bobby' }))
  })

  it('shows nothing of an install on another machine', async () => {
    installing(install({ machineId: 'laptop' }), [machine()])
    renderPanel()
    await screen.findByText('desk')
    expect(screen.queryByText('Putting Koala on this machine')).toBeNull()
  })
})
