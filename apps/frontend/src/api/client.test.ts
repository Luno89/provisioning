import { describe, it, expect } from 'vitest'
import { api, errorMessage, API_BASE, backendAddress } from './client'

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

describe('where the backend is', () => {
  it('is the page\'s own origin in a built app, so a deployed one never calls the visitor\'s localhost', () => {
    expect(backendAddress({ dev: false, pageOrigin: 'https://luno.nowrinkles.dev' })).toEqual({
      apiBase: '/api', origin: 'https://luno.nowrinkles.dev', socketUrl: 'https://luno.nowrinkles.dev',
    })
  })

  it('is the dev backend on :3001 while developing', () => {
    expect(backendAddress({ dev: true, pageOrigin: 'http://localhost:5173' })).toEqual({
      apiBase: 'http://localhost:3001/api', origin: 'http://localhost:3001', socketUrl: 'http://localhost:3001',
    })
  })

  it('is whatever the build was told, when it was told', () => {
    expect(backendAddress({ apiBase: 'http://localhost:3002/api', dev: true, pageOrigin: 'http://localhost:5174' }).origin).toBe('http://localhost:3002')
    expect(backendAddress({ socketUrl: 'http://sockets.test', dev: false, pageOrigin: 'https://a.test' }).socketUrl).toBe('http://sockets.test')
  })
})
