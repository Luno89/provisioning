import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AccountMachines from './AccountMachines'
import * as machinesApi from '../api'

const place = vi.fn()

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof machinesApi>()),
  useMyMachines: vi.fn(),
  useCreateMyJoinCode: () => ({ mutate: vi.fn(), isPending: false, isError: false, data: undefined, error: null }),
  usePutKoalaOn: () => ({ mutate: place, isPending: false, isError: false, error: null }),
}))

const machine = (over: Partial<machinesApi.AccountMachine> = {}): machinesApi.AccountMachine => ({
  id: 'desk', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-11-01T00:00:00Z', meshIp: '100.64.0.7', online: true, koalaWanted: false, holdsKoala: false, ...over,
})

const show = (machines: machinesApi.AccountMachine[], hasKoala = false) => {
  vi.mocked(machinesApi.useMyMachines).mockReturnValue({ data: { machines, koala: null } } as never)
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
    show([machine({ koalaRefused: { reason: '"bobby" is taken', at: '2026-11-17T10:00:00Z' } })])
    expect(await screen.findByText('Koala could not be put here: "bobby" is taken')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(place).toHaveBeenCalledWith({ machineId: 'desk', name: 'bobby' }, expect.anything()))
  })

  it('says a machine\'s token could not be renewed, why, and when it stops working unless it is', async () => {
    show([machine({ tokenRenewal: { reason: 'the machine did not keep its new token', failedAt: '2026-11-17T10:00:00Z', stopsAt: '2026-12-01T00:00:00Z' } })], true)
    const line = await screen.findByText(/^Its token could not be renewed: the machine did not keep its new token; it stops working on /)
    expect(line.textContent).toContain(new Date('2026-12-01T00:00:00Z').toLocaleDateString())
    expect(line.textContent).toMatch(/unless it is$/)
  })

  it('says nothing of either when nothing went wrong', async () => {
    show([machine()])
    await screen.findByText('desk')
    expect(screen.queryByText(/could not be put here/)).toBeNull()
    expect(screen.queryByText(/could not be renewed/)).toBeNull()
  })
})
