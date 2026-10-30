import { describe, expect, it } from 'vitest'
import { tryAgainAfter } from './socket-reconnect'

describe('a connection the server closed', () => {
  it('is opened again once, carrying whatever session the browser holds now, since the server closes a connection when its session ends', () => {
    expect(tryAgainAfter('io server disconnect')).toBe(true)
  })

  it('is left to the client\'s own reconnecting for anything else, and stays closed when the page closed it', () => {
    expect(tryAgainAfter('transport close')).toBe(false)
    expect(tryAgainAfter('io client disconnect')).toBe(false)
  })
})
