import { describe, expect, expectTypeOf, it } from 'vitest'
import { type SignInPlace, getMe, logout, register, resendSignUpCode, signIn, signInPlace, verifySignUp } from './api'
import type { Wire } from '../../test/backend/wire'
import type { AccountsSignIn } from '../../../../backend/src/accounts/routes/auth'
import type { InstanceSignIn } from '../../../../backend/src/instances/routes/sign-in'
import { PASSWORD, startBackend } from '../../test/backend/site'
import { anyOf } from '../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend(() => undefined)

expectTypeOf<Wire<AccountsSignIn>>().toExtend<SignInPlace>()
expectTypeOf<Wire<InstanceSignIn>>().toExtend<SignInPlace>()

describe('the session the browser holds, against the real sign-in routes', () => {
  it('has no session before signing in, so getMe answers null rather than throwing', async () => {
    expect(await getMe()).toBeNull()
  })

  it('offers the sign-in place with no providers configured, starting at root\'s own sign-in', async () => {
    expect(await signInPlace()).toEqual({ url: '/api/auth/oidc/start', providers: [] })
  })

  it('refuses the first sign-up without the setup code, saying so', async () => {
    await expect(register({ email: 'first@koala.test', password: PASSWORD, inviteCode: 'wrong' })).rejects.toMatchObject({ response: { status: 403, data: { error: anyOf(String) } } })
  })

  it('signs the first account in with the setup code, and getMe then reads that account with its permissions', async () => {
    const user = await backend.signIn('first@koala.test')
    const me = await getMe()
    expect(me).toMatchObject({ id: user.id, email: 'first@koala.test', twoFactorEnabled: false, hasPassword: true, confirmWith: 'password' })
    expect(me?.permissions).toMatchObject({ administer: true, 'manage-own-account': true })
  })

  it('signs out, after which getMe answers null, and root ends its own session in this browser without asking, so signing in again asks for the password', async () => {
    const endAtRoot = await logout()
    expect(await getMe()).toBeNull()
    expect(endAtRoot).toEqual(anyOf(String))
    expect(await backend.signedOutAtRoot(endAtRoot!)).toBe(`${backend.origin}/`)
    expect(await backend.resumeAt()).toEqual(anyOf(String))
  })

  it('refuses a wrong password with 401 and the words the sign-in page shows', async () => {
    await expect(signIn(await backend.resumeAt(), { email: 'first@koala.test', password: 'not the password at all' })).rejects.toMatchObject({ response: { status: 401, data: { error: anyOf(String) } } })
    expect(await getMe()).toBeNull()
  })

  it('refuses a later sign-up that brings no invite', async () => {
    await expect(register({ email: 'second@koala.test', password: PASSWORD })).rejects.toMatchObject({ response: { status: 403, data: { error: 'An invite code is required to create an account' } } })
  })

  it('confirms an invited sign-up by the emailed code: a wrong code is refused, a new one can be sent, the right one signs the account in', async () => {
    const invited = await backend.invite()
    const resume = await backend.resumeAt()
    const pending = await register({ email: 'second@koala.test', password: PASSWORD, inviteCode: invited })
    expect(pending).toEqual({ verify: anyOf(String) })
    await expect(verifySignUp(resume, { id: pending.verify!, code: '000000' })).rejects.toMatchObject({ response: { status: 401, data: { error: 'That code is not the one we sent; check the email and try again' } } })
    expect(await resendSignUpCode(pending.verify!)).toEqual({ verify: pending.verify })
    const made = await verifySignUp(resume, { id: pending.verify!, code: backend.codeMailedTo('second@koala.test') })
    expect(made).toEqual({ next: anyOf(String) })
    await backend.landedFrom(made.next!)
    expect(await getMe()).toMatchObject({ email: 'second@koala.test', twoFactorEnabled: false })
    expect((await getMe())?.permissions).toMatchObject({ administer: false })
  })

  it('starts the sign-in again once the one it resumes has ended', async () => {
    await expect(signIn('/oidc/interaction/no-such-sign-in', { email: 'first@koala.test', password: PASSWORD })).rejects.toMatchObject({ response: { status: 410, data: { error: 'This sign-in has ended; sign in again' } } })
  })
})
