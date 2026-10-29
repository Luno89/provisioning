import { describe, expect, it } from 'vitest'
import { canDo, canOn } from './permissions'

describe('what the session and a record say may be done', () => {
  it('allows a session action only when the server said yes', () => {
    expect(canDo({ administer: true }, 'administer')).toBe(true)
    expect(canDo({ administer: false }, 'administer')).toBe(false)
    expect(canDo({}, 'see-all-work')).toBe(false)
    expect(canDo(undefined, 'manage-accounts')).toBe(false)
  })

  it('allows a record action only when the record lists it', () => {
    expect(canOn({ can: ['invite', 'change-files'] }, 'change-files')).toBe(true)
    expect(canOn({ can: ['invite'] }, 'change-files')).toBe(false)
    expect(canOn({}, 'invite')).toBe(false)
    expect(canOn(undefined, 'invite')).toBe(false)
  })
})
