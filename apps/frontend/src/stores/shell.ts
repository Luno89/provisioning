import { create } from 'zustand'
import { parseHash, formatHash, shouldReplace, resolveView, type Route } from '../lib/route'

export const PLATFORM_VIEWS = [
  'projects', 'vps-catalog', 'mesh',
  'accounts', 'nginx', 'temporal', 'settings',
] as const

export const KOALA_VIEWS = ['chat', 'studio', 'infrastructure'] as const

export const KNOWN_VIEWS = [...PLATFORM_VIEWS, ...KOALA_VIEWS] as const

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
  setView: (view: ViewName, path?: string[]) => void

  koalaOpen: boolean
  setKoalaOpen: (open: boolean | ((open: boolean) => boolean)) => void

  projectsOpen: boolean
  setProjectsOpen: (open: boolean | ((open: boolean) => boolean)) => void


  user: AppUser | null
  setUser: (user: AppUser | null) => void
  authLoading: boolean
  setAuthLoading: (loading: boolean) => void

  notifications: Notification[]
  pushNotification: (notification: Omit<Notification, 'nid'>) => number
  dismissNotification: (nid: number) => void

  confirmDestroy: DestroyTarget | null
  setConfirmDestroy: (target: DestroyTarget | null) => void
  clearDestroyFor: (id: string) => void

  appDeploy: AppDeployPreset | null
  openAppDeploy: (preset: AppDeployPreset) => void
  closeAppDeploy: () => void
}

export interface AppDeployPreset {
  appType: string
  name?: string
}

let lastRoute: Route | undefined = parseHash(window.location.hash)

let nextNotificationId = 0

export const useShellStore = create<ShellState>((set) => ({
  view: resolveView(parseHash(window.location.hash)?.view, KNOWN_VIEWS, 'chat') as ViewName,

  setView: (view, path = []) => set((state) => {
    const current = parseHash(window.location.hash)
    const there = current?.view === view && (!path.length || current.path.join('/') === path.join('/'))
    if (state.view === view && there) return state
    if (there) {
      lastRoute = current
      return { view }
    }
    const next: Route = { view, path }
    const hash = formatHash(view, path)
    if (shouldReplace(lastRoute, next)) window.history.replaceState(null, '', hash)
    else window.history.pushState(null, '', hash)
    lastRoute = next
    return { view }
  }),

  koalaOpen: true,
  setKoalaOpen: (open) => set((s) => ({
    koalaOpen: typeof open === 'function' ? open(s.koalaOpen) : open,
  })),

  projectsOpen: true,
  setProjectsOpen: (open) => set((s) => ({
    projectsOpen: typeof open === 'function' ? open(s.projectsOpen) : open,
  })),


  user: isMockedAuth() ? MOCK_USER : null,
  setUser: (user) => set({ user }),
  authLoading: !isMockedAuth(),
  setAuthLoading: (authLoading) => set({ authLoading }),

  notifications: [],
  pushNotification: (notification) => {
    const nid = Date.now() + (++nextNotificationId / 1000);
    set((s) => ({ notifications: [...s.notifications, { ...notification, nid }] }));
    return nid;
  },
  dismissNotification: (nid) => set((s) => ({
    notifications: s.notifications.filter((n) => n.nid !== nid),
  })),

  confirmDestroy: null,
  setConfirmDestroy: (confirmDestroy) => set({ confirmDestroy }),
  clearDestroyFor: (id) => set((s) => (
    s.confirmDestroy?.id === id ? { confirmDestroy: null } : s
  )),

  appDeploy: null,
  openAppDeploy: (appDeploy) => set({ appDeploy }),
  closeAppDeploy: () => set({ appDeploy: null }),
}))

export function startHistorySync(): () => void {
  const onPop = () => {
    const route = parseHash(window.location.hash)
    lastRoute = route
    useShellStore.setState({
      view: resolveView(route?.view, KNOWN_VIEWS, 'infrastructure') as ViewName,
    })
  }
  window.addEventListener('popstate', onPop)
  window.addEventListener('hashchange', onPop)
  return () => {
    window.removeEventListener('popstate', onPop)
    window.removeEventListener('hashchange', onPop)
  }
}
