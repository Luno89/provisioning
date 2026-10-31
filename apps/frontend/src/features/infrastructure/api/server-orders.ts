import { api } from '../../../api/client'
import type { MailReport } from '../../../shared/components/MailReport'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `ServerOrder` in `apps/backend/src/infrastructure/lib/server-orders.ts` as `viewOf` in
 * `apps/backend/src/infrastructure/services/ServerOrderService.ts` sends it, which is the authority.
 */
export type ServerOrderState =
  | 'quoted' | 'quote-cancelled' | 'bought' | 'paying' | 'waiting-check' | 'delivering' | 'installing-key'
  | 'waiting-ssh' | 'dns' | 'waiting-release' | 'bootstrapping' | 'ready' | 'failed' | 'stopped'

export interface ServerQuote {
  currency: string
  withoutTax: number
  tax: number
  withTax: number
  monthly: number
  setupFee: number
  lines: { description: string; amount: number }[]
  contracts: { name: string; url: string }[]
}

export interface ServerOrder {
  id: string
  provider: 'ovh'
  purpose: 'root'
  subsidiary: string
  planCode: string
  planLabel: string
  datacenter: string
  domain: string
  ingressDomain: string
  acmeEmail: string
  dns: { domain: string; ingress: string }
  signIn: { id: string; label: string }[]
  quote: ServerQuote
  quotedAt: string
  orderId?: number
  boughtAt?: string
  serviceName?: string
  ip?: string
  release?: string
  state: ServerOrderState
  said: string
  hasSetupCode: boolean
  hasSshKey: boolean
  log?: string[]
  createdAt: string
  updatedAt: string
  reverseDns?: ServerReverseDns
  mail?: MailReport
}

export interface QuoteAsk {
  planCode: string
  planLabel: string
  datacenter: string
  domain: string
  ingressDomain: string
  acmeEmail: string
  domainDns?: string
  ingressDns?: string
  signIn?: SignInAsk[]
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `RootSignInProvider` in `apps/backend/src/infrastructure/lib/root-sign-in.ts`, built from
 * `SIGN_IN_PROVIDERS` in `apps/backend/src/accounts/lib/sign-in-providers.ts`, which is the authority.
 */
export interface SignInField {
  key: string
  label: string
  env: string
  secret: boolean
  optional: boolean
  placeholder: string
}

export interface RootSignInProvider {
  id: string
  label: string
  fields: SignInField[]
  register: { url?: string; how: string }
  redirectUri?: string
}

export interface SignInAsk {
  id: string
  values: Record<string, string>
}

export interface ZoneView {
  zone: string
  nameservers: string[]
  provider?: string
  label?: string
  problem?: string
  credentials: boolean
  setup?: string
}

export const serverOrderKeys = {
  all: ['server-orders'] as const,
  one: (id: string) => ['server-orders', id] as const,
  zones: (zones: readonly string[]) => ['server-orders', 'zones', ...zones] as const,
  signIn: (domain: string) => ['server-orders', 'sign-in-providers', domain] as const,
}

export const FOLLOWED: readonly ServerOrderState[] = ['bought', 'paying', 'waiting-check', 'delivering', 'installing-key', 'waiting-ssh', 'dns', 'waiting-release', 'bootstrapping']

export const listServerOrders = (): Promise<ServerOrder[]> => api.get<ServerOrder[]>('/server-orders').then((r) => r.data)
export const getServerOrder = (id: string): Promise<ServerOrder> => api.get<ServerOrder>(`/server-orders/${encodeURIComponent(id)}`).then((r) => r.data)
export const checkZones = (zones: readonly string[]): Promise<ZoneView[]> =>
  api.get<ZoneView[]>('/server-orders/zones', { params: { zone: zones }, paramsSerializer: { indexes: null } }).then((r) => r.data)
export const listRootSignInProviders = (domain: string): Promise<RootSignInProvider[]> =>
  api.get<RootSignInProvider[]>('/server-orders/sign-in-providers', { params: domain ? { domain } : {} }).then((r) => r.data)
export const quoteServer = (ask: QuoteAsk): Promise<ServerOrder> => api.post<ServerOrder>('/server-orders/quote', ask).then((r) => r.data)
export const buyServer = (id: string, confirmedTotal: number): Promise<ServerOrder> =>
  api.post<ServerOrder>(`/server-orders/${encodeURIComponent(id)}/buy`, { confirmedTotal }).then((r) => r.data)
export const cancelServerOrder = (id: string): Promise<ServerOrder> => api.delete<ServerOrder>(`/server-orders/${encodeURIComponent(id)}`).then((r) => r.data)
export const revealSetupCode = (id: string): Promise<string> =>
  api.post<{ setupCode: string }>(`/server-orders/${encodeURIComponent(id)}/setup-code`, {}).then((r) => r.data.setupCode)
export const revealSshKey = (id: string): Promise<{ privateKey: string; host?: string }> =>
  api.post<{ privateKey: string; host?: string }>(`/server-orders/${encodeURIComponent(id)}/ssh-key`, {}).then((r) => r.data)

/**
 * ── DUPLICATED, KNOWINGLY ── `ServerReverseDns` in `apps/backend/src/infrastructure/lib/reverse-dns.ts` is the authority.
 */
export interface ServerReverseDns {
  ip: string
  name: string
  state: 'set' | 'already' | 'waiting' | 'refused'
  said: string
  at: string
}
