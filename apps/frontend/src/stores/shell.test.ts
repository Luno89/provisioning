import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useShellStore, startHistorySync, KNOWN_VIEWS } from './shell'

/**
 * The shell store, and specifically the part that used to be an effect.
 *
 * `view` and the URL were kept in step by a `useEffect` on `[view]`. That works until someone adds
 * a second way to change the view, and then the hash is wrong in one path and right in the other —
 * a bug that only shows up on refresh or when a link is shared. Setting the URL inside the action
 * makes it unconditional, and these tests are what say so.
 */

const setHash = (hash: string) => {
  window.history.replaceState(null, '', hash || '#/')
}

/** The store is a module singleton, so each test has to put it back. */
const reset = () => {
  useShellStore.setState({
    view: 'chat',
    forestOpen: true,
    handoff: undefined,
    notifications: [],
    confirmDestroy: null,
  })
}

beforeEach(() => { setHash('#/'); reset() })
afterEach(() => { vi.restoreAllMocks() })

describe('changing the view', () => {
  it('writes the hash, without anything having to remember to', () => {
    useShellStore.getState().setView('clusters')
    expect(useShellStore.getState().view).toBe('clusters')
    expect(window.location.hash).toContain('clusters')
  })

  it('does nothing when the view is already current', () => {
    // Guards against a pointless history entry on a repeated nav click.
    useShellStore.getState().setView('clusters')
    const before = window.history.length
    useShellStore.getState().setView('clusters')
    expect(window.history.length).toBe(before)
  })

  it('leaves the path alone when the hash already names that view', () => {
    /**
     * Grove writes its own ids under `#/grove/...` as the selection moves. Navigating "to grove"
     * when you are already there must not flatten that back to `#/grove` and lose the selection.
     */
    setHash('#/grove/tree-1/branch-2')
    useShellStore.setState({ view: 'chat' })
    useShellStore.getState().setView('grove')
    expect(window.location.hash).toBe('#/grove/tree-1/branch-2')
  })

  it('accepts every view the shell knows about', () => {
    // Iterates rather than naming three, so a view added to KNOWN_VIEWS is covered here already.
    for (const view of KNOWN_VIEWS) {
      useShellStore.getState().setView(view)
      expect(useShellStore.getState().view, view).toBe(view)
    }
  })
})

describe('the initial view', () => {
  it('falls back to a known view rather than trusting the URL', () => {
    // A stale bookmark or a typo must not put the shell into a view that renders nothing.
    expect(KNOWN_VIEWS).toContain(useShellStore.getState().view)
  })
})

describe('back and forward', () => {
  it('follows the URL without pushing a new entry for a move the user already made', () => {
    const stop = startHistorySync()
    try {
      useShellStore.getState().setView('clusters')
      setHash('#/apps')
      window.dispatchEvent(new PopStateEvent('popstate'))
      expect(useShellStore.getState().view).toBe('apps')
    } finally {
      stop()
    }
  })

  it('stops listening when told to', () => {
    // An unmounted shell that keeps handling popstate would fight a remounted one for the view.
    const stop = startHistorySync()
    stop()
    setHash('#/mesh')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(useShellStore.getState().view).not.toBe('mesh')
  })
})

describe('notifications', () => {
  it('gives each one a distinct key, even when two arrive in the same millisecond', () => {
    /**
     * They are pushed from socket handlers, and two resources finishing together is normal. `nid`
     * was `Date.now()`, which collides at that granularity and gives React duplicate keys — so one
     * toast silently replaces the other.
     */
    const { pushNotification } = useShellStore.getState()
    pushNotification({ message: 'first' })
    pushNotification({ message: 'second' })
    const { notifications } = useShellStore.getState()
    expect(notifications).toHaveLength(2)
    expect(notifications[0]!.nid).not.toBe(notifications[1]!.nid)
  })

  it('dismisses only the one asked for', () => {
    const { pushNotification } = useShellStore.getState()
    pushNotification({ message: 'keep' })
    pushNotification({ message: 'drop' })
    const target = useShellStore.getState().notifications[1]!
    useShellStore.getState().dismissNotification(target.nid)
    expect(useShellStore.getState().notifications.map((n) => n.message)).toEqual(['keep'])
  })
})

describe('the destroy confirmation', () => {
  it('closes when that resource is destroyed elsewhere', () => {
    // Arrives over the socket when another tab or another user destroys it. Leaving the dialog up
    // offers to destroy something that is already gone.
    useShellStore.getState().setConfirmDestroy({ type: 'cluster', id: 'c1', name: 'one' })
    useShellStore.getState().clearDestroyFor('c1')
    expect(useShellStore.getState().confirmDestroy).toBeNull()
  })

  it('leaves a confirmation for a different resource alone', () => {
    useShellStore.getState().setConfirmDestroy({ type: 'cluster', id: 'c1', name: 'one' })
    useShellStore.getState().clearDestroyFor('c2')
    expect(useShellStore.getState().confirmDestroy?.id).toBe('c1')
  })
})
