import { describe, expect, it } from 'vitest'
import { resumePathFrom } from './resume'

describe('going back into a sign-in root was asked for', () => {
  it('returns to root\'s own sign-in step once someone has signed in here, and nowhere else', () => {
    expect(resumePathFrom('?resume=%2Foidc%2Finteraction%2FaBc_12-x')).toBe('/oidc/interaction/aBc_12-x')
    expect(resumePathFrom('?resume=https%3A%2F%2Fevil.example.com')).toBeUndefined()
    expect(resumePathFrom('?resume=%2F%2Fevil.example.com%2Foidc%2Finteraction%2Fx')).toBeUndefined()
    expect(resumePathFrom('?resume=%2Foidc%2Finteraction%2Fx%2F..%2F..%2Fapi')).toBeUndefined()
    expect(resumePathFrom('')).toBeUndefined()
  })
})
