import { create } from 'zustand'
import { parseHash, formatHash, shouldReplace, resolveView, type Route } from '../lib/route'

/**
 * The application shell: which view is open, who is signed in, and what is being announced.
 *
 * ── WHY A STORE AND NOT MORE useState IN App ──
 * These lived in `App.tsx` as `useState`, and the setters were passed down as props — `setView` to
 * the sidebar, `setConfirmDestroy` to the clusters screen, `setForestOpen` to the nav. Fifteen raw
 * setters crossing component boundaries, which means a child could put the shell into any state at
 * all and the only way to find out who did was to grep for the setter.
 *
 * ── WHY THIS SLICE AND NOT ONE BIG STORE ──
 * Only what is genuinely shell-wide lives here. "Which cluster row is expanded" and "what step the
 * deploy wizard is on" were also in App, and they are going DOWN into the screens that render them,
 * not sideways into a store — a global that one component reads is a local with extra steps, and it
 * makes that screen impossible to understand or test on its own.
 *
 * ── WHY SERVER DATA IS NOT HERE ──
 * That is react-query's. Putting fetched records in a store means hand-writing caching, request
 * dedup, invalidate-after-mutate and refetch — which is what react-query already does, and doing it
 * by hand is exactly how `CloudAccounts` ended up with nine raw `fetch` calls and 21 `useState`.
 */

/** Every view the shell can show. Derived from the nav so the two cannot disagree. */
export const FOREST_VIEWS = [
  'clusters', 'apps', 'projects', 'vps-catalog', 'mesh',
  'accounts', 'services', 'nginx', 'temporal', 'settings',
] as const

export const KOALA_VIEWS = ['grove', 'chat', 'personas', 'lab'] as const

export const KNOWN_VIEWS = [...FOREST_VIEWS, ...KOALA_VIEWS] as const

export type ViewName = typeof KNOWN_VIEWS[number]

export interface AppUser {
  id: string
  email: string
  createdAt?: string
  isAdmin?: boolean
  twoFactorEnabled?: boolean
  twoFactorPhone?: string
  twoFactorPreferredMethod?: string
  /** Anything else the session endpoint returns. Narrowed as screens start reading it. */
  [key: string]: unknown
}

/** A toast. `nid` is assigned on push so React has a stable key. */
export interface Notification {
  nid: number
  id?: string
  type?: string
  name?: string
  message?: string
  /** A change nobody asked for from this tab — rendered in yellow rather than green. */
  outOfBand?: boolean
  [key: string]: unknown
}

export interface DestroyTarget {
  type: 'cluster' | 'app'
  id: string
  name: string
  isAbort?: boolean
}

/**
 * Test and E2E runs start signed in.
 *
 * Port 5174 is Playwright's frontend (see playwright.config.js), where the backend runs with
 * `IS_E2E=true` and `requireAuth` short-circuits to a mock user — so the UI must not sit on a login
 * screen waiting for a session that will never be checked.
 */
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
  /** Changes the view AND the URL. There is no way to do one without the other — see `setView`. */
  setView: (view: ViewName) => void

  forestOpen: boolean
  /** Accepts a value or an updater, because the sidebar toggles it without reading it first. */
  setForestOpen: (open: boolean | ((open: boolean) => boolean)) => void

  /** A conversation to open with a message already queued. Cleared once Chat has sent it. */
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
  /** Clears the confirmation if it is for this resource — used when something is destroyed elsewhere. */
  clearDestroyFor: (id: string) => void
}

/**
 * The last route we wrote, so `shouldReplace` can tell a navigation from a correction.
 *
 * Module scope rather than store state: it is bookkeeping for the history API, nothing renders it,
 * and putting it in the store would re-render every subscriber whenever the URL was tidied.
 */
let lastRoute: Route | undefined = parseHash(window.location.hash)

export const useShellStore = create<ShellState>((set) => ({
  /**
   * The URL wins on load, so a refresh keeps your place and a link opens where it points.
   *
   * Chat is the front door. The landing view was `clusters` — a table of infrastructure, which is
   * what you look at when something is wrong, not when you arrive.
   */
  view: resolveView(parseHash(window.location.hash)?.view, KNOWN_VIEWS, 'chat') as ViewName,

  /**
   * ── THE URL IS PART OF SETTING THE VIEW ──
   *
   * This was a `useEffect` on `[view]` in App. Moving it into the action makes "the view and the
   * hash agree" true by construction: there is no longer a code path that changes one without the
   * other, and nothing has to remember to run an effect.
   *
   * Grove owns the ids under its own view — it writes them itself as the selection moves — so when
   * the hash already names this view, the existing path is left alone rather than being flattened.
   */
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

  // Open by default: collapsed, a first-time user sees two items and no way to tell that ten more
  // exist. Folding the infrastructure away is about hierarchy, not about hiding it.
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
  /**
   * Pushed from socket handlers, which live outside the React tree. That is the case a store is
   * genuinely better at than lifting state: the handler needs no component, no ref and no closure
   * over a setter that may have gone stale.
   */
  pushNotification: (notification) => set((s) => ({
    notifications: [...s.notifications, { ...notification, nid: Date.now() + Math.random() }],
  })),
  dismissNotification: (nid) => set((s) => ({
    notifications: s.notifications.filter((n) => n.nid !== nid),
  })),

  confirmDestroy: null,
  setConfirmDestroy: (confirmDestroy) => set({ confirmDestroy }),
  // A resource destroyed in another tab or by another user must not leave a dialog offering to
  // destroy it again.
  clearDestroyFor: (id) => set((s) => (
    s.confirmDestroy?.id === id ? { confirmDestroy: null } : s
  )),
}))

/**
 * Keeps the store in step when the user presses Back or Forward.
 *
 * Called once from the shell. Without it the buttons left the application entirely, because
 * nothing had ever pushed an entry. Returns its own cleanup so an effect can return it directly.
 */
export function startHistorySync(): () => void {
  const onPop = () => {
    const route = parseHash(window.location.hash)
    lastRoute = route
    // Straight to `set`, not through `setView`: the URL is already what the user asked for, and
    // routing through the action would push a duplicate history entry for a move we did not make.
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
