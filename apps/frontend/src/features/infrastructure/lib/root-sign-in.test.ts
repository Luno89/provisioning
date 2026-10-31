import { describe, expect, it } from 'vitest'
import { signInAsks, withValue } from './root-sign-in'

describe('the sign-in providers root is given', () => {
  it('sends only the providers with something typed, trimmed, and nothing blank', () => {
    let values = withValue({}, 'google', 'clientId', ' id-1 ')
    values = withValue(values, 'google', 'clientSecret', 'secret-1')
    values = withValue(values, 'github', 'clientId', '   ')
    values = withValue(values, 'oidc', 'label', '')
    expect(signInAsks(values)).toEqual([{ id: 'google', values: { clientId: 'id-1', clientSecret: 'secret-1' } }])
    expect(signInAsks({})).toEqual([])
  })
})
