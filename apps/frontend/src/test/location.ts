import { vi } from 'vitest'

export const replacedLocation = () => {
  const was = window.location
  const went = vi.fn()
  const assign = vi.fn()
  const install = () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        get href() { return was.href },
        set href(to: string) { went(to) },
        get origin() { return was.origin },
        get protocol() { return was.protocol },
        get host() { return was.host },
        get hostname() { return was.hostname },
        get port() { return was.port },
        get pathname() { return was.pathname },
        get search() { return was.search },
        get hash() { return was.hash },
        assign,
        replace: vi.fn(),
        reload: vi.fn(),
      },
    })
  }
  const restore = () => {
    Object.defineProperty(window, 'location', { configurable: true, value: was })
    window.history.replaceState({}, '', '/')
  }
  return { went, assign, install, restore }
}
