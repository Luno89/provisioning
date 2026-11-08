import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  changePassword, endOtherSessions, forgotPassword, getPersonRemoval, getProjectInviteLimits, getRemovalPreview, listInvites, listPeople,
  mintInvite, removeMyAccount, removePerson, resendPasswordReset, resetPassword, saveTwoFactor, sendConfirmCode, setOwnInviteAccounts, setProjectInviteLimits,
} from './api'
import type { Invite, PersonEntry, ProjectInviteLimits, RemovalPreview } from './types'
import { getMe, login } from '../platform'
import { PASSWORD, startBackend } from '../../test/backend/site'
import { followedTemporal, mountAccounts } from '../../test/backend/accounts'
import type { Wire } from '../../test/backend/wire'
import { anyOf, objectWith } from '../../../../backend/src/platform/lib/test-matchers'
import type { InviteView } from '../../../../backend/src/platform/lib/invite-codes'
import type { PersonEntry as BackendPersonEntry } from '../../../../backend/src/accounts/services/AccountRemovalService'
import type { InviteLimits } from '../../../../backend/src/accounts/lib/project-invite-limits'
import type { ProjectInvitePerson } from '../../../../backend/src/accounts/services/ProjectInviteLimitsService'

const temporal = followedTemporal()
const backend = await startBackend((site) => mountAccounts(site, temporal))
const NEW_PASSWORD = 'a different integration password'

expectTypeOf<Wire<InviteView>>().toExtend<Invite>()
expectTypeOf<Wire<BackendPersonEntry>>().toExtend<PersonEntry>()
expectTypeOf<Wire<InviteLimits & { people: ProjectInvitePerson[] }>>().toExtend<ProjectInviteLimits>()
expectTypeOf<Wire<{ email: string; blockers: string[] }>>().toExtend<RemovalPreview>()

describe('the people and invites an operator manages, combined', () => {
  it('mints an invite with its code once, and lists it afterwards without the code', async () => {
    const owner = await backend.signIn()
    expect(await listInvites()).toEqual([])
    const minted = await mintInvite()
    expect(minted).toEqual(objectWith({ id: anyOf(String), code: anyOf(String), createdBy: owner.id, expired: false, expiresAt: anyOf(String) }))
    const listed = await listInvites()
    expect(listed).toEqual([objectWith({ id: minted.id, createdBy: owner.id, expired: false })])
    expect(listed[0]).not.toHaveProperty('code')
  })

  it('reads the project invite limits, changes them, and refuses a limit that is not a number', async () => {
    expect(await getProjectInviteLimits()).toEqual({ accounts: 10, perHour: 20, people: [] })
    expect(await setProjectInviteLimits({ accounts: 5, perHour: 7 })).toEqual({ accounts: 5, perHour: 7 })
    await expect(setProjectInviteLimits({ accounts: -1 })).rejects.toMatchObject({ response: { status: 400, data: { error: anyOf(String) } } })
  })

  it('gives one person an allowance of their own, listed among the limits, and answers 404 for someone who has no account', async () => {
    await backend.db.accounts.saveUser({ id: 'guest', email: 'guest@koala.test', emailVerified: true, twoFactorEnabled: false, createdAt: new Date().toISOString() })
    expect(await setOwnInviteAccounts('guest', 3)).toEqual({ id: 'guest', email: 'guest@koala.test', made: 0, own: 3 })
    expect((await getProjectInviteLimits()).people).toEqual([{ id: 'guest', email: 'guest@koala.test', made: 0, own: 3 }])
    await backend.db.accounts.deleteUser('guest')
    await expect(setOwnInviteAccounts('nobody', 3)).rejects.toMatchObject({ response: { status: 404, data: { error: 'There is no such account' } } })
  })

  it('lists people with whether each is an operator', async () => {
    expect(await listPeople()).toEqual([objectWith({ email: 'owner@koala.test', operator: true, createdAt: anyOf(String) })])
  })

  it('previews removing the only operator with the blocker that says why it cannot go', async () => {
    const [me] = await listPeople()
    expect(await getPersonRemoval(me!.id)).toEqual({ email: 'owner@koala.test', blockers: ['this is the only admin account; make someone else an admin first'] })
    expect(await getRemovalPreview()).toEqual({ email: 'owner@koala.test', blockers: ['this is the only admin account; make someone else an admin first'] })
    await expect(getPersonRemoval('nobody')).rejects.toMatchObject({ response: { status: 404, data: { error: 'There is no such account' } } })
  })

  it('refuses to remove a person without their email typed, and someone who has no account', async () => {
    const [me] = await listPeople()
    await expect(removePerson(me!.id, 'wrong')).rejects.toMatchObject({ response: { status: 400, data: { error: 'Type the account\'s email, owner@koala.test, to confirm' } } })
    await expect(removePerson('nobody', 'x')).rejects.toMatchObject({ response: { status: 404 } })
  })
})

describe('a person\'s own password, second factor and sessions, combined', () => {
  it('asks for the password, not a code, while two-factor is off', async () => {
    await expect(sendConfirmCode()).rejects.toMatchObject({ response: { status: 400, data: { error: 'Confirm with your password; no code is sent for this account' } } })
  })

  it('refuses a password change without the current password, and makes it with it', async () => {
    await expect(changePassword({ password: NEW_PASSWORD })).rejects.toMatchObject({ response: { status: 403, data: { error: anyOf(String) } } })
    await changePassword({ password: NEW_PASSWORD, current: PASSWORD })
    expect(await getMe()).toMatchObject({ email: 'owner@koala.test' })
  })

  it('ends the other sessions and keeps this one', async () => {
    await endOtherSessions()
    expect(await getMe()).toMatchObject({ email: 'owner@koala.test' })
  })

  it('turns two-factor on with the password as proof, after which a confirmation code is mailed', async () => {
    await expect(saveTwoFactor({ enabled: true }, { password: 'not it' })).rejects.toMatchObject({ response: { status: 403, data: { error: anyOf(String) } } })
    expect(await saveTwoFactor({ enabled: true, preferredMethod: 'email' }, { password: NEW_PASSWORD })).toEqual(objectWith({ twoFactorEnabled: true, twoFactorPreferredMethod: 'email', confirmWith: 'two-factor' }))
    await sendConfirmCode()
    expect(backend.codeMailedTo('owner@koala.test')).toMatch(/^\d{6}$/)
  })

  it('resets a forgotten password by the mailed code, and the new password signs in', async () => {
    const asked = await forgotPassword('member@koala.test')
    expect(asked).toEqual({ reset: anyOf(String) })
    await backend.signInAnother('member@koala.test')
    const reset = await forgotPassword('member@koala.test')
    expect(await resendPasswordReset(reset.reset)).toEqual({ reset: reset.reset })
    await expect(resetPassword({ id: reset.reset, code: '000000', password: NEW_PASSWORD })).rejects.toMatchObject({ response: { status: 401 } })
    expect(await resetPassword({ id: reset.reset, code: backend.codeMailedTo('member@koala.test'), password: NEW_PASSWORD })).toEqual(objectWith({ email: 'member@koala.test' }))
    expect(await login({ email: 'member@koala.test', password: NEW_PASSWORD })).toEqual(objectWith({ user: objectWith({ email: 'member@koala.test' }) }))
  })
})

describe('what someone who is not an operator may do on root', () => {
  it('refuses them the invites and the people', async () => {
    await expect(listInvites()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(mintInvite()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(listPeople()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(getProjectInviteLimits()).rejects.toMatchObject({ response: { status: 403 } })
  })

  it('removes their own account once they type its email and give their password, which starts its removal and ends the session', async () => {
    expect(await getRemovalPreview()).toEqual({ email: 'member@koala.test', blockers: [] })
    await expect(removeMyAccount('wrong', { password: NEW_PASSWORD })).rejects.toMatchObject({ response: { status: 400 } })
    await expect(removeMyAccount('member@koala.test', { password: 'not it' })).rejects.toMatchObject({ response: { status: 403, data: { error: anyOf(String) } } })
    expect(await removeMyAccount('member@koala.test', { password: NEW_PASSWORD })).toEqual({ state: 'running', done: [] })
    expect(temporal.started).toEqual([objectWith({ workflowType: 'RootAccountRemovalWorkflow' })])
    expect(await getMe()).toBeNull()
  })
})
