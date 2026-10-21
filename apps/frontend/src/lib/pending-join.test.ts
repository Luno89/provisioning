import { beforeEach, describe, expect, it } from 'vitest'
import { forgetJoin, pendingJoin, rememberJoin, safeNext } from './pending-join'

beforeEach(() => window.localStorage.clear())

describe('an invite carried across signing up', () => {
  it('is remembered until it is taken, and ignores anything that is not one', () => {
    expect(pendingJoin()).toBeUndefined()
    rememberJoin({ code: 'C', project: 'J' })
    expect(pendingJoin()).toEqual({ code: 'C', project: 'J' })
    forgetJoin()
    expect(pendingJoin()).toBeUndefined()
    window.localStorage.setItem('koala.pending-join', '{"code":1}')
    expect(pendingJoin()).toBeUndefined()
  })

  it('goes on only to a path on this site', () => {
    expect(safeNext('/shared/abc')).toBe('/shared/abc')
    expect([safeNext('//evil.example.com'), safeNext('https://evil.example.com'), safeNext('/\\evil'), safeNext(null)]).toEqual([undefined, undefined, undefined, undefined])
  })
})
