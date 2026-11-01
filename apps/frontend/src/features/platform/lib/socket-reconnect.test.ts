import { describe, expect, it } from 'vitest'
import { tryAgainAfter, tryAgainAfterRefusal } from './socket-reconnect'

describe('a connection the server closed', () => {
  it('is opened again once, carrying whatever session the browser holds now, since the server closes a connection when its session ends', () => {
    expect(tryAgainAfter('io server disconnect')).toBe(true)
  })

  it('is left to the client\'s own reconnecting for anything else, and stays closed when the page closed it', () => {
    expect(tryAgainAfter('transport close')).toBe(false)
    expect(tryAgainAfter('io client disconnect')).toBe(false)
  })
})

describe('a connection the server refused', () => {
  it('is tried again when the server could not check its session', () => {
    expect(tryAgainAfterRefusal(Object.assign(new Error('the session could not be checked; try again'), { data: { tryAgain: true } }))).toBe(true)
  })

  it('stays refused when the session is not one, or the refusal says nothing', () => {
    expect(tryAgainAfterRefusal(new Error('Unauthorized'))).toBe(false)
    expect(tryAgainAfterRefusal(Object.assign(new Error('x'), { data: { tryAgain: 'yes' } }))).toBe(false)
    expect(tryAgainAfterRefusal(undefined)).toBe(false)
  })
})
