import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useShellStore, startHistorySync, KNOWN_VIEWS } from './shell'

const setHash = (hash: string) => {
  window.history.replaceState(null, '', hash || '#/')
}

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
    useShellStore.getState().setView('clusters')
    const before = window.history.length
    useShellStore.getState().setView('clusters')
    expect(window.history.length).toBe(before)
  })

  it('leaves the path alone when the hash already names that view', () => {
    setHash('#/grove/tree-1/branch-2')
    useShellStore.setState({ view: 'chat' })
    useShellStore.getState().setView('grove')
    expect(window.location.hash).toBe('#/grove/tree-1/branch-2')
  })

  it('accepts every view the shell knows about', () => {
    for (const view of KNOWN_VIEWS) {
      useShellStore.getState().setView(view)
      expect(useShellStore.getState().view, view).toBe(view)
    }
  })
})

describe('the initial view', () => {
  it('falls back to a known view rather than trusting the URL', () => {
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
    const stop = startHistorySync()
    stop()
    setHash('#/mesh')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(useShellStore.getState().view).not.toBe('mesh')
  })
})

describe('notifications', () => {
  it('gives each one a distinct key, even when two arrive in the same millisecond', () => {
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
