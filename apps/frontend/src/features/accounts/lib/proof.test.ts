import { describe, expect, it } from 'vitest'
import { newPasswordProblem, proofAsked, proofReady, proofSent, sendsCode } from './proof'

describe('the proof a risky change asks for', () => {
  it('is the password where the account confirms with it, and a six-digit code otherwise', () => {
    expect(sendsCode('password')).toBe(false)
    expect(sendsCode('two-factor')).toBe(true)
    expect(sendsCode('email-code')).toBe(true)
    expect(proofReady('password', { password: 'pw' })).toBe(true)
    expect(proofReady('password', { code: '123456' })).toBe(false)
    expect(proofReady('two-factor', { code: ' 123456 ' })).toBe(true)
    expect(proofReady('email-code', { code: '12345' })).toBe(false)
  })

  it('sends only the half that is asked for', () => {
    expect(proofSent('password', { password: 'pw', code: '123456' })).toEqual({ password: 'pw' })
    expect(proofSent('two-factor', { password: 'pw', code: ' 123456 ' })).toEqual({ code: '123456' })
  })

  it('says what it asks for', () => {
    expect(proofAsked('password')).toBe('Your password')
    expect(proofAsked('email-code')).toBe('The code we email you')
    expect(proofAsked('two-factor')).toBe('A code from your two-factor sign-in')
  })
})

describe('a new password typed twice', () => {
  it('is twelve characters or more and the same both times', () => {
    expect(newPasswordProblem('short', 'short')).toBe('Use at least 12 characters')
    expect(newPasswordProblem('long-enough-pw', 'long-enough-px')).toBe('The two passwords are not the same')
    expect(newPasswordProblem('long-enough-pw', 'long-enough-pw')).toBeUndefined()
  })
})
