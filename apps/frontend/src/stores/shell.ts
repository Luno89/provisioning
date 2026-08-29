import { create } from 'zustand'
import { parseHash, formatHash, shouldReplace, resolveView, type Route } from '../lib/route'

export const FOREST_VIEWS = [
  'clusters', 'apps', 'projects', 'vps-catalog', 'mesh',
  'accounts', 'services', 'nginx', 'temporal', 'settings',
] as const

export const KOALA_VIEWS = ['grove', 'chat', 'personas', 'lab'] as const

export const KNOWN_VIEWS = [...FOREST_VIEWS, ...KOALA_VIEWS] as const

export type ViewName = typeof KNOWN_VIEWS[number]

import type { SessionUser as AppUser } from '../api/auth'
export type { AppUser }

export interface Notification {
  nid: number
  id?: string
  type?: string
  name?: string
  message?: string
  outOfBand?: boolean
  [key: string]: unknown
}

export interface DestroyTarget {
  type: 'cluster' | 'app'
  id: string
  name: string
  isAbort?: boolean
}

const isMockedAuth = (): boolean =>
  import.meta.env?.MODE === 'test'
  || import.meta.env?.VITE_IS_E2E === 'true'
  || window.location.port === '5174'

const MOCK_USER: AppUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  createdAt: new Date().toISOString(),
}

interface ShellState {
  view: ViewName
  setView: (view: ViewName) => void

  forestOpen: boolean
  setForestOpen: (open: boolean | ((open: boolean) => boolean)) => void

  handoff: { branchId: string; prompt: string } | undefined
  setHandoff: (handoff: { branchId: string; prompt: string } | undefined) => void

  user: AppUser | null
  setUser: (user: AppUser | null) => void
  authLoading: boolean
  setAuthLoading: (loading: boolean) => void

  notifications: Notification[]
  pushNotification: (notification: Omit<Notification, 'nid'>) => void
  dismissNotification: (nid: number) => void

  confirmDestroy: DestroyTarget | null
  setConfirmDestroy: (target: DestroyTarget | null) => void
  clearDestroyFor: (id: string) => void
}

let lastRoute: Route | undefined = parseHash(window.location.hash)

export const useShellStore = create<ShellState>((set) => ({
  view: resolveView(parseHash(window.location.hash)?.view, KNOWN_VIEWS, 'chat') as ViewName,

  setView: (view) => set((state) => {
    if (state.view === view) return state
    const current = parseHash(window.location.hash)
    if (current?.view === view) {
      lastRoute = current
      return { view }
    }
    const next: Route = { view, path: [] }
    const hash = formatHash(view)
    if (shouldReplace(lastRoute, next)) window.history.replaceState(null, '', hash)
    else window.history.pushState(null, '', hash)
    lastRoute = next
    return { view }
  }),

  forestOpen: true,
  setForestOpen: (open) => set((s) => ({
    forestOpen: typeof open === 'function' ? open(s.forestOpen) : open,
  })),

  handoff: undefined,
  setHandoff: (handoff) => set({ handoff }),

  user: isMockedAuth() ? MOCK_USER : null,
  setUser: (user) => set({ user }),
  authLoading: !isMockedAuth(),
  setAuthLoading: (authLoading) => set({ authLoading }),

  notifications: [],
  pushNotification: (notification) => set((s) => ({
    notifications: [...s.notifications, { ...notification, nid: Date.now() + Math.random() }],
  })),
  dismissNotification: (nid) => set((s) => ({
    notifications: s.notifications.filter((n) => n.nid !== nid),
  })),

  confirmDestroy: null,
  setConfirmDestroy: (confirmDestroy) => set({ confirmDestroy }),
  clearDestroyFor: (id) => set((s) => (
    s.confirmDestroy?.id === id ? { confirmDestroy: null } : s
  )),
}))

export function startHistorySync(): () => void {
  const onPop = () => {
    const route = parseHash(window.location.hash)
    lastRoute = route
    useShellStore.setState({
      view: resolveView(route?.view, KNOWN_VIEWS, 'clusters') as ViewName,
    })
  }
  window.addEventListener('popstate', onPop)
  window.addEventListener('hashchange', onPop)
  return () => {
    window.removeEventListener('popstate', onPop)
    window.removeEventListener('hashchange', onPop)
  }
}
