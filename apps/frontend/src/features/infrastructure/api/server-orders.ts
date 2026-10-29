import { api } from '../../../api/client'

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
}

export interface QuoteAsk {
  planCode: string
  planLabel: string
  datacenter: string
  domain: string
  ingressDomain: string
  acmeEmail: string
}

export const serverOrderKeys = {
  all: ['server-orders'] as const,
  one: (id: string) => ['server-orders', id] as const,
}

export const FOLLOWED: readonly ServerOrderState[] = ['bought', 'paying', 'waiting-check', 'delivering', 'installing-key', 'waiting-ssh', 'dns', 'waiting-release', 'bootstrapping']

export const listServerOrders = (): Promise<ServerOrder[]> => api.get<ServerOrder[]>('/server-orders').then((r) => r.data)
export const getServerOrder = (id: string): Promise<ServerOrder> => api.get<ServerOrder>(`/server-orders/${encodeURIComponent(id)}`).then((r) => r.data)
export const quoteServer = (ask: QuoteAsk): Promise<ServerOrder> => api.post<ServerOrder>('/server-orders/quote', ask).then((r) => r.data)
export const buyServer = (id: string, confirmedTotal: number): Promise<ServerOrder> =>
  api.post<ServerOrder>(`/server-orders/${encodeURIComponent(id)}/buy`, { confirmedTotal }).then((r) => r.data)
export const cancelServerOrder = (id: string): Promise<ServerOrder> => api.delete<ServerOrder>(`/server-orders/${encodeURIComponent(id)}`).then((r) => r.data)
export const revealSetupCode = (id: string): Promise<string> =>
  api.post<{ setupCode: string }>(`/server-orders/${encodeURIComponent(id)}/setup-code`, {}).then((r) => r.data.setupCode)
export const revealSshKey = (id: string): Promise<{ privateKey: string; host?: string }> =>
  api.post<{ privateKey: string; host?: string }>(`/server-orders/${encodeURIComponent(id)}/ssh-key`, {}).then((r) => r.data)
