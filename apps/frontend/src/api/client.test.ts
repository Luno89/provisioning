import { describe, it, expect } from 'vitest'
import { api, errorMessage, API_BASE } from './client'

describe('the shared api client', () => {
  it('carries credentials, so no call site has to remember to', () => {
    // The failure this prevents: `withCredentials` was set three ways at once — a global default in
    // App.tsx plus 90 explicit call sites plus 20 `credentials: 'include'` — and the global one
    // silently coupled every component to App.tsx having been imported first.
    expect(api.defaults.withCredentials).toBe(true)
  })

  it('has one base URL', () => {
    expect(api.defaults.baseURL).toBe(API_BASE)
  })
})

describe('errorMessage', () => {
  it("prefers the server's own message", () => {
    // The whole reason this exists: axios's `message` is "Request failed with status code 400",
    // which tells a user nothing. The backend sends a sentence that does.
    expect(errorMessage({ response: { data: { error: 'That provider is not configured.' } } }))
      .toBe('That provider is not configured.')
  })

  it('falls back to the transport error when there is no response at all', () => {
    // A network failure or a CORS rejection has no response body.
    expect(errorMessage({ message: 'Network Error' })).toBe('Network Error')
  })

  it('never returns undefined, whatever it is handed', () => {
    // It is rendered directly, so an undefined here is a blank error box.
    expect(errorMessage(undefined)).toBe('Something went wrong.')
    expect(errorMessage(null)).toBe('Something went wrong.')
    expect(errorMessage({})).toBe('Something went wrong.')
    expect(errorMessage({ response: {} })).toBe('Something went wrong.')
  })
})
