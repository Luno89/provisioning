import { describe, it, expect } from 'vitest'
import { api, errorMessage, API_BASE } from './client'

describe('the shared api client', () => {
  it('carries credentials, so no call site has to remember to', () => {
    expect(api.defaults.withCredentials).toBe(true)
  })

  it('has one base URL', () => {
    expect(api.defaults.baseURL).toBe(API_BASE)
  })
})

describe('errorMessage', () => {
  it("prefers the server's own message", () => {
    expect(errorMessage({ response: { data: { error: 'That provider is not configured.' } } }))
      .toBe('That provider is not configured.')
  })

  it('falls back to the transport error when there is no response at all', () => {
    expect(errorMessage({ message: 'Network Error' })).toBe('Network Error')
  })

  it('never returns undefined, whatever it is handed', () => {
    expect(errorMessage(undefined)).toBe('Something went wrong.')
    expect(errorMessage(null)).toBe('Something went wrong.')
    expect(errorMessage({})).toBe('Something went wrong.')
    expect(errorMessage({ response: {} })).toBe('Something went wrong.')
  })
})
