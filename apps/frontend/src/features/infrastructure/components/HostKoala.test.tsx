import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useShellStore } from '../../platform'
import * as ordersApi from '../api/server-orders'
import * as vpsApi from '../api/vps-catalog'
import { HostKoala, OrderDetail, QuoteCard, SignInChoices, ZoneLine } from './HostKoala'

vi.mock('../api/server-orders', async (importOriginal) => ({
  ...(await importOriginal<typeof ordersApi>()),
  listServerOrders: vi.fn(),
  getServerOrder: vi.fn(),
  quoteServer: vi.fn(),
  buyServer: vi.fn(),
  cancelServerOrder: vi.fn(),
  revealSetupCode: vi.fn(),
  revealSshKey: vi.fn(),
  checkZones: vi.fn(),
  listRootSignInProviders: vi.fn(),
}))
vi.mock('../api/vps-catalog', async (importOriginal) => ({ ...(await importOriginal<typeof vpsApi>()), getVpsCatalog: vi.fn() }))

const order: ordersApi.ServerOrder = {
  id: 'o1', provider: 'ovh', purpose: 'root', subsidiary: 'AU', planCode: 'vps-2027-model2', planLabel: 'VPS-2 2027', datacenter: 'SYD',
  domain: 'nowrinkles.dev', ingressDomain: 'nowrinkles.app', acmeEmail: 'me@example.com', dns: { domain: 'cloudflare', ingress: 'porkbun' },
  quote: { currency: 'AUD', withoutTax: 14, tax: 1.4, withTax: 15.4, monthly: 14, setupFee: 0, lines: [{ description: 'VPS-2 2027', amount: 14 }], contracts: [{ name: 'General Terms', url: 'https://example.ovh/terms.pdf' }] },
  signIn: [], quotedAt: 'x', state: 'quoted', said: 'Priced', hasSetupCode: false, hasSshKey: false, createdAt: 'x', updatedAt: 'x',
}

const signInProviders = (domain: string): ordersApi.RootSignInProvider[] => [
  {
    id: 'google', label: 'Google', register: { url: 'https://console.cloud.google.com/apis/credentials', how: 'Create an OAuth client ID.' },
    fields: [
      { key: 'clientId', label: 'Client ID', env: 'GOOGLE_CLIENT_ID', secret: false, optional: false, placeholder: '' },
      { key: 'clientSecret', label: 'Client secret', env: 'GOOGLE_CLIENT_SECRET', secret: true, optional: false, placeholder: '' },
    ],
    ...(domain ? { redirectUri: `https://app.${domain}/api/auth/provider/google/callback` } : {}),
  },
  {
    id: 'sso', label: 'A provider added later', register: { how: 'Register a client at your provider.' },
    fields: [
      { key: 'issuer', label: 'Issuer', env: 'SSO_ISSUER', secret: false, optional: false, placeholder: 'https://login.example.com' },
      { key: 'clientId', label: 'Client ID', env: 'SSO_CLIENT_ID', secret: false, optional: false, placeholder: '' },
      { key: 'clientSecret', label: 'Client secret', env: 'SSO_CLIENT_SECRET', secret: true, optional: false, placeholder: '' },
    ],
  },
]

const wrap = (children: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ordersApi.listRootSignInProviders).mockImplementation(async (domain) => signInProviders(domain))
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

  it('offers every sign-in provider the backend describes, with root\'s redirect URI, and sends those given with the quote', async () => {
    vi.mocked(ordersApi.listServerOrders).mockResolvedValue([])
    vi.mocked(vpsApi.getVpsCatalog).mockResolvedValue({
      offers: [{ id: 'ovh:vps-2027-model2', provider: 'ovh', planId: 'vps-2027-model2', label: 'VPS-2 2027', vcpu: 4, cpuType: 'shared', arch: 'x86', ramGb: 8, diskGb: 75, priceMonthly: 14, currency: 'AUD', taxIncluded: false, hourlyBilling: false, locations: ['SYD'], provisionable: false, pricePerGbRam: 1.75 }],
      sources: [], fetchedAt: 'x',
    })
    vi.mocked(ordersApi.quoteServer).mockResolvedValue(order)
    wrap(<HostKoala />)
    await screen.findByRole('option', { name: /VPS-2 2027/ })
    expect(await screen.findByTestId('sign-in-sso')).toBeTruthy()
    expect(screen.getByText('A provider added later')).toBeTruthy()
    fireEvent.change(document.getElementById('host-koala-plan')!, { target: { value: 'ovh:vps-2027-model2' } })
    fireEvent.change(document.getElementById('host-koala-datacenter')!, { target: { value: 'SYD' } })
    fireEvent.change(document.getElementById('host-koala-domain')!, { target: { value: 'nowrinkles.dev' } })
    fireEvent.change(document.getElementById('host-koala-ingress')!, { target: { value: 'nowrinkles.app' } })
    fireEvent.change(document.getElementById('host-koala-email')!, { target: { value: 'me@example.com' } })
    expect((await screen.findByTestId('redirect-google', {}, { timeout: 3000 })).textContent).toBe('https://app.nowrinkles.dev/api/auth/provider/google/callback')
    fireEvent.change(document.getElementById('host-koala-sign-in-google-clientId')!, { target: { value: 'google-id' } })
    fireEvent.change(document.getElementById('host-koala-sign-in-google-clientSecret')!, { target: { value: 'google-fake-secret' } })
    expect((document.getElementById('host-koala-sign-in-google-clientSecret') as HTMLInputElement).type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Price it' }))
    await waitFor(() => expect(ordersApi.quoteServer).toHaveBeenCalledWith(expect.objectContaining({ signIn: [{ id: 'google', values: { clientId: 'google-id', clientSecret: 'google-fake-secret' } }] })))
  })
})

describe('the sign-in providers for root', () => {
  it('shows each provider\'s fields, where it is made and how, and tells each typed value by provider and field', () => {
    const typed: string[] = []
    wrap(<SignInChoices providers={signInProviders('nowrinkles.dev')} values={{ sso: { issuer: 'https://login.example.com' } }} onValue={(id, key, value) => typed.push(`${id}.${key}=${value}`)} />)
    expect(screen.getByRole('link', { name: /console.cloud.google.com/ }).getAttribute('href')).toBe('https://console.cloud.google.com/apis/credentials')
    expect(screen.getByText('Register a client at your provider.')).toBeTruthy()
    expect(screen.getByText('type root\'s domain above to see it')).toBeTruthy()
    expect((document.getElementById('host-koala-sign-in-sso-issuer') as HTMLInputElement).value).toBe('https://login.example.com')
    fireEvent.change(document.getElementById('host-koala-sign-in-sso-clientId')!, { target: { value: 'koala' } })
    expect(typed).toEqual(['sso.clientId=koala'])
  })

  it('says on the price card who people sign in with', () => {
    wrap(<QuoteCard order={{ ...order, signIn: [{ id: 'google', label: 'Google' }] }} onBought={vi.fn()} />)
    expect(screen.getByTestId('quote-sign-in').textContent).toBe('People sign in to root with Google or a password.')
  })
})

describe('who serves each domain\'s DNS', () => {
  const providers = [{ name: 'cloudflare', label: 'Cloudflare DNS' }, { name: 'porkbun', label: 'Porkbun DNS' }]

  it('says the provider its nameservers name and whether its credentials are stored, and lets the operator choose another', () => {
    const chosen: string[] = []
    wrap(<ZoneLine zone={{ zone: 'nowrinkles.app', nameservers: ['a.ns.porkbun.com'], provider: 'porkbun', label: 'Porkbun DNS', credentials: false, setup: 'Turn on API Access.' }} override="" onOverride={(provider) => chosen.push(provider)} providers={providers} />)
    expect(screen.getByText('Porkbun DNS, no credentials stored. Turn on API Access.')).toBeDefined()
    fireEvent.change(screen.getByLabelText('DNS provider for nowrinkles.app'), { target: { value: 'cloudflare' } })
    expect(chosen).toEqual(['cloudflare'])
  })

  it('says why when no provider Koala knows serves the zone', () => {
    wrap(<ZoneLine zone={{ zone: 'elsewhere.test', nameservers: ['ns1.example.net'], problem: 'elsewhere.test: its nameservers (ns1.example.net) are not Cloudflare DNS or Porkbun DNS', credentials: false }} override="" onOverride={() => undefined} providers={providers} />)
    expect(screen.getByText(/ns1\.example\.net/)).toBeDefined()
    expect(screen.getByText('Koala needs to know who serves this zone\'s DNS.')).toBeDefined()
  })
})
