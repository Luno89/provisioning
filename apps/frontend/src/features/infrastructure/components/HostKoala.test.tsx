import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useShellStore } from '../../platform'
import * as ordersApi from '../api/server-orders'
import * as vpsApi from '../api/vps-catalog'
import { HostKoala, OrderDetail, QuoteCard } from './HostKoala'

vi.mock('../api/server-orders', async (importOriginal) => ({
  ...(await importOriginal<typeof ordersApi>()),
  listServerOrders: vi.fn(),
  getServerOrder: vi.fn(),
  quoteServer: vi.fn(),
  buyServer: vi.fn(),
  cancelServerOrder: vi.fn(),
  revealSetupCode: vi.fn(),
  revealSshKey: vi.fn(),
}))
vi.mock('../api/vps-catalog', async (importOriginal) => ({ ...(await importOriginal<typeof vpsApi>()), getVpsCatalog: vi.fn() }))

const order: ordersApi.ServerOrder = {
  id: 'o1', provider: 'ovh', purpose: 'root', subsidiary: 'AU', planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD',
  domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com',
  quote: { currency: 'AUD', withoutTax: 14, tax: 1.4, withTax: 15.4, monthly: 14, setupFee: 0, lines: [{ description: 'VPS-2 2027', amount: 14 }], contracts: [{ name: 'General Terms', url: 'https://example.ovh/terms.pdf' }] },
  quotedAt: 'x', state: 'quoted', said: 'Priced', hasSetupCode: false, hasSshKey: false, createdAt: 'x', updatedAt: 'x',
}

const wrap = (children: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>)

beforeEach(() => {
  vi.clearAllMocks()
  useShellStore.setState({ user: { id: 'op', email: 'op@example.com', permissions: { administer: true } } as never })
})

describe('the price card', () => {
  it('shows what is charged now, the monthly price and the contracts, and buys only after they are accepted, at that total', async () => {
    vi.mocked(ordersApi.buyServer).mockResolvedValue({ ...order, state: 'bought', said: 'Bought' })
    const bought = vi.fn()
    wrap(<QuoteCard order={order} onBought={bought} />)
    expect(screen.getByText('15.40 AUD')).toBeTruthy()
    expect(screen.getByText('14.00 AUD')).toBeTruthy()
    expect(screen.getByRole('link', { name: /General Terms/ }).getAttribute('href')).toBe('https://example.ovh/terms.pdf')
    const buy = screen.getByRole('button', { name: 'Buy for 15.40 AUD' }) as HTMLButtonElement
    expect(buy.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(buy.disabled).toBe(false)
    fireEvent.click(buy)
    await waitFor(() => expect(ordersApi.buyServer).toHaveBeenCalledWith('o1', 15.4))
    await waitFor(() => expect(bought).toHaveBeenCalled())
  })

  it('cancels a quote without buying', async () => {
    vi.mocked(ordersApi.cancelServerOrder).mockResolvedValue({ ...order, state: 'quote-cancelled', said: 'Cancelled' })
    wrap(<QuoteCard order={order} onBought={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(ordersApi.cancelServerOrder).toHaveBeenCalledWith('o1'))
    expect(ordersApi.buyServer).not.toHaveBeenCalled()
  })
})

describe('a bought server', () => {
  it('follows the order, then opens root and shows the setup code once', async () => {
    vi.mocked(ordersApi.getServerOrder).mockResolvedValue({ ...order, state: 'ready', said: 'Root is running at https://app.nowrinkles.dev, on v2026.10.29.', orderId: 123456, ip: '203.0.113.7', hasSetupCode: true, hasSshKey: true, log: ['bootstrap done'] })
    vi.mocked(ordersApi.revealSetupCode).mockResolvedValue('0123456789abcdef0123456789abcdef')
    wrap(<OrderDetail id="o1" />)
    expect(await screen.findByText(/Root is running/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open root/ }).getAttribute('href')).toBe('https://app.nowrinkles.dev')
    expect(screen.getByTestId('server-order-log').textContent).toContain('bootstrap done')
    fireEvent.click(screen.getByRole('button', { name: /Show the setup code/ }))
    expect(await screen.findByText('0123456789abcdef0123456789abcdef')).toBeTruthy()
  })

  it('offers to stop following while OVHcloud checks the order', async () => {
    vi.mocked(ordersApi.getServerOrder).mockResolvedValue({ ...order, state: 'waiting-check', said: 'Waiting for OVHcloud to check the order', orderId: 123456 })
    wrap(<OrderDetail id="o1" />)
    expect(await screen.findByText(/Waiting for OVHcloud to check/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop following' })).toBeTruthy()
  })
})

describe('the page', () => {
  it('is the operator\'s alone', () => {
    useShellStore.setState({ user: { id: 'u', email: 'u@example.com', permissions: { administer: false } } as never })
    vi.mocked(ordersApi.listServerOrders).mockResolvedValue([])
    vi.mocked(vpsApi.getVpsCatalog).mockResolvedValue({ offers: [], sources: [], fetchedAt: 'x' })
    wrap(<HostKoala />)
    expect(screen.getByText(/Only the operator of this server/)).toBeTruthy()
  })

  it('prices the plan and datacenter picked with both domains', async () => {
    vi.mocked(ordersApi.listServerOrders).mockResolvedValue([])
    vi.mocked(vpsApi.getVpsCatalog).mockResolvedValue({
      offers: [{ id: 'ovh:vps-2027-model2', provider: 'ovh', planId: 'vps-2027-model2', label: 'VPS-2 2027', vcpu: 4, cpuType: 'shared', arch: 'x86', ramGb: 8, diskGb: 75, priceMonthly: 14, currency: 'AUD', taxIncluded: false, hourlyBilling: false, locations: ['SGP', 'SYD'], provisionable: false, pricePerGbRam: 1.75 }],
      sources: [], fetchedAt: 'x',
    })
    vi.mocked(ordersApi.quoteServer).mockResolvedValue(order)
    wrap(<HostKoala />)
    await screen.findByRole('option', { name: /VPS-2 2027/ })
    fireEvent.change(document.getElementById('host-koala-plan')!, { target: { value: 'ovh:vps-2027-model2' } })
    fireEvent.change(document.getElementById('host-koala-datacenter')!, { target: { value: 'SYD' } })
    fireEvent.change(document.getElementById('host-koala-domain')!, { target: { value: 'nowrinkles.dev' } })
    fireEvent.change(document.getElementById('host-koala-ingress')!, { target: { value: 'nowrinkles.app' } })
    fireEvent.change(document.getElementById('host-koala-email')!, { target: { value: 'me@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Price it' }))
    await waitFor(() => expect(ordersApi.quoteServer).toHaveBeenCalledWith({ planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD', domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com' }))
    expect(ordersApi.buyServer).not.toHaveBeenCalled()
  })
})
