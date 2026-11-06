import { describe, expect, it } from 'vitest'
import { getMe, login, logout, resendSignUpCode, signInPlace, verifySignUp } from './api'
import { PASSWORD, startBackend } from '../../test/backend/site'
import { anyOf } from '../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend(() => undefined)

describe('the session the browser holds, against the real sign-in routes', () => {
  it('has no session before signing in, so getMe answers null rather than throwing', async () => {
    expect(await getMe()).toBeNull()
  })

  it('offers the sign-in place with no providers configured and no address to go to', async () => {
    expect(await signInPlace()).toEqual({ url: null, providers: [] })
  })

  it('refuses the first sign-up without the setup code, saying so', async () => {
    await expect(login({ email: 'first@koala.test', password: PASSWORD, inviteCode: 'wrong' }, { register: true })).rejects.toMatchObject({ response: { status: 403, data: { error: anyOf(String) } } })
  })

  it('signs the first account in with the setup code, and getMe then reads that account with its permissions', async () => {
    const user = await backend.signIn('first@koala.test')
    const me = await getMe()
    expect(me).toMatchObject({ id: user.id, email: 'first@koala.test', twoFactorEnabled: false, hasPassword: true, confirmWith: 'password' })
    expect(me?.permissions).toMatchObject({ administer: true, 'manage-own-account': true })
  })

  it('signs out, after which getMe answers null', async () => {
    await logout()
    expect(await getMe()).toBeNull()
  })

  it('refuses a wrong password with 401 and the words the sign-in page shows', async () => {
    await expect(login({ email: 'first@koala.test', password: 'not the password at all' })).rejects.toMatchObject({ response: { status: 401, data: { error: anyOf(String) } } })
    expect(await getMe()).toBeNull()
  })

  it('refuses a later sign-up that brings no invite', async () => {
    await expect(login({ email: 'second@koala.test', password: PASSWORD }, { register: true })).rejects.toMatchObject({ response: { status: 403, data: { error: 'An invite code is required to create an account' } } })
  })

  it('confirms an invited sign-up by the emailed code: a wrong code is refused, a new one can be sent, the right one signs the account in', async () => {
    const invited = await backend.invite()
    const pending = await login({ email: 'second@koala.test', password: PASSWORD, inviteCode: invited }, { register: true })
    expect(pending).toEqual({ verify: anyOf(String) })
    await expect(verifySignUp({ id: pending.verify!, code: '000000' })).rejects.toMatchObject({ response: { status: 401, data: { error: 'That code is not the one we sent; check the email and try again' } } })
    expect(await resendSignUpCode(pending.verify!)).toEqual({ verify: pending.verify })
    const made = await verifySignUp({ id: pending.verify!, code: backend.codeMailedTo('second@koala.test') })
    expect(made).toMatchObject({ success: true, user: { email: 'second@koala.test', twoFactorEnabled: false } })
    expect(await getMe()).toMatchObject({ email: 'second@koala.test' })
    expect((await getMe())?.permissions).toMatchObject({ administer: false })
  })
})
