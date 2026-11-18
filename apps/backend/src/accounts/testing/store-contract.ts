import { describe, expect, it } from 'vitest';
import type { InviteMetadata, UserMetadata } from '../../platform/index.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';
import { RESET_CODES_SENT, type PasswordReset } from '../lib/password-reset.js';
import { SIGN_UP_CODES_SENT, type PendingSignUp } from '../lib/sign-up.js';
import type { TwoFactorCode } from '../lib/second-factor.js';
import type { AccountsStore } from '../store.js';

const person = (id: string, email = `${id}@example.com`): UserMetadata => ({ id, email, twoFactorEnabled: false, emailVerified: true, createdAt: '2026-10-01T00:00:00.000Z' });
const loose = (user: UserMetadata, fields: Record<string, unknown>): UserMetadata => ({ ...user, ...fields }) as UserMetadata;
const loosely = (held: InviteMetadata, fields: Record<string, unknown>): InviteMetadata => ({ ...held, ...fields }) as InviteMetadata;
const invite = (id: string, code: string, extra: Partial<InviteMetadata> = {}): InviteMetadata => ({ id, codeHash: inviteCodeHash(code), createdBy: 'owner-1', createdAt: '2026-10-01T00:00:00.000Z', ...extra });
const later = (minutes: number): Date => new Date(Date.UTC(2030, 0, 1, 0, minutes));
const nothingRelated = { watermarkKeys: [], ingestIds: [], projectIds: [] };

const signUp = (id: string): PendingSignUp => ({ id, email: `${id}@example.com`, passwordHash: 'p', inviteHash: 'i', codeHash: 'c1', wrong: 0, sent: 1, expiresAt: later(0) });
const reset = (id: string): PasswordReset => ({ id, ownerId: 'owner-1', email: 'owner@example.com', codeHash: 'c1', wrong: 0, sent: 1, expiresAt: later(0) });
const twoFactor = (id: string, ownerId = 'owner-1'): TwoFactorCode => ({ id, ownerId, codeHash: 'h1', expiresAt: later(5) });

interface CodeKind<T extends { id: string; wrong: number; sent: number; codeHash: string; expiresAt: Date }> {
  noun: string;
  most: number;
  make: (id: string) => T;
  save: (store: AccountsStore, row: T) => Promise<void>;
  get: (store: AccountsStore, id: string) => Promise<T | undefined>;
  wrong: (store: AccountsStore, id: string) => Promise<number>;
  resend: (store: AccountsStore, id: string, codeHash: string, expiresAt: Date) => Promise<boolean>;
  remove: (store: AccountsStore, id: string) => Promise<boolean>;
}

function emailedCodeContract<T extends { id: string; wrong: number; sent: number; codeHash: string; expiresAt: Date }>(kind: CodeKind<T>, make: () => Promise<AccountsStore>): void {
  describe(kind.noun, () => {
    it('keeps what was saved, replaces it whole when saved again, and hands back a copy', async () => {
      const store = await make();
      const row = kind.make('a');
      await kind.save(store, row);
      expect(await kind.get(store, 'a')).toEqual(row);
      expect(await kind.get(store, 'b')).toBeUndefined();
      await kind.save(store, { ...row, codeHash: 'c2', wrong: 3 });
      expect(await kind.get(store, 'a')).toEqual({ ...row, codeHash: 'c2', wrong: 3 });
      const read = await kind.get(store, 'a');
      read!.codeHash = 'changed';
      read!.expiresAt.setUTCFullYear(1999);
      expect(await kind.get(store, 'a')).toEqual({ ...row, codeHash: 'c2', wrong: 3 });
    });

    it('counts each wrong code and says how many there have been', async () => {
      const store = await make();
      await kind.save(store, kind.make('a'));
      await kind.save(store, kind.make('b'));
      expect(await kind.wrong(store, 'a')).toBe(1);
      expect(await kind.wrong(store, 'a')).toBe(2);
      expect(await kind.wrong(store, 'b')).toBe(1);
      expect((await kind.get(store, 'a'))?.wrong).toBe(2);
    });

    it('counts every wrong code of several tried at once', async () => {
      const store = await make();
      await kind.save(store, kind.make('a'));
      const counts = await Promise.all([1, 2, 3, 4].map(() => kind.wrong(store, 'a')));
      expect([...counts].sort()).toEqual([1, 2, 3, 4]);
    });

    it('counts a wrong code for one it does not have as past any limit', async () => {
      const store = await make();
      expect(await kind.wrong(store, 'gone')).toBe(Number.POSITIVE_INFINITY);
    });

    it('sends a new code only while fewer than the most have been sent, leaving the wrong count alone', async () => {
      const store = await make();
      await kind.save(store, { ...kind.make('a'), wrong: 2 });
      for (let sent = 1; sent < kind.most; sent += 1) expect(await kind.resend(store, 'a', `c${sent + 1}`, later(sent))).toBe(true);
      expect(await kind.get(store, 'a')).toMatchObject({ sent: kind.most, codeHash: `c${kind.most}`, expiresAt: later(kind.most - 1), wrong: 2 });
      expect(await kind.resend(store, 'a', 'one-too-many', later(59))).toBe(false);
      expect(await kind.get(store, 'a')).toMatchObject({ sent: kind.most, codeHash: `c${kind.most}` });
      expect(await kind.resend(store, 'gone', 'c9', later(1))).toBe(false);
    });

    it('lets only as many new codes through as are left when asked at once', async () => {
      const store = await make();
      await kind.save(store, { ...kind.make('a'), sent: kind.most - 2 });
      const sent = await Promise.all([1, 2, 3, 4].map((n) => kind.resend(store, 'a', `c${n}`, later(n))));
      expect(sent.filter(Boolean)).toHaveLength(2);
      expect((await kind.get(store, 'a'))?.sent).toBe(kind.most);
    });

    it('removes it once, and says whether it was there', async () => {
      const store = await make();
      await kind.save(store, kind.make('a'));
      expect(await kind.remove(store, 'a')).toBe(true);
      expect(await kind.remove(store, 'a')).toBe(false);
      expect(await kind.get(store, 'a')).toBeUndefined();
    });
  });
}

export function accountsStoreContract(make: () => Promise<AccountsStore>): void {
  describe('accounts', () => {
    it('keeps an account as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      const alice = { ...person('alice'), roles: ['operator' as const], inviteAccounts: 3 };
      await store.saveUser(alice);
      await store.saveUser(person('bob'));
      expect(await store.getUserById('alice')).toEqual(alice);
      expect(await store.getUserById('nobody')).toBeUndefined();
      expect((await store.getUsers()).map((user) => user.id).sort()).toEqual(['alice', 'bob']);
      await store.saveUser({ ...person('alice'), emailVerified: false });
      expect(await store.getUserById('alice')).toEqual({ ...person('alice'), emailVerified: false });
      await store.deleteUser('alice');
      await store.deleteUser('alice');
      expect((await store.getUsers()).map((user) => user.id)).toEqual(['bob']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      const alice = { ...person('alice'), signInLinks: [{ issuer: 'https://one.example', subject: 'a-1' }] };
      await store.saveUser(alice);
      const read = await store.getUserById('alice');
      read!.emailVerified = false;
      read!.signInLinks!.push({ issuer: 'https://two.example', subject: 'a-2' });
      (await store.getUsers())[0]!.email = 'changed@example.com';
      expect(await store.getUserById('alice')).toEqual(alice);
    });

    it('finds an account by the address as typed, trimmed and lowercased, against the address as saved', async () => {
      const store = await make();
      await store.saveUser(person('alice', 'alice@example.com'));
      await store.saveUser(person('shouty', 'Shouty@Example.com'));
      expect((await store.getUserByEmail('alice@example.com'))?.id).toBe('alice');
      expect((await store.getUserByEmail('  ALICE@Example.com '))?.id).toBe('alice');
      expect(await store.getUserByEmail('nobody@example.com')).toBeUndefined();
      expect(await store.getUserByEmail('shouty@example.com')).toBeUndefined();
      expect(await store.getUserByEmail('Shouty@Example.com')).toBeUndefined();
    });

    it('refuses a second account with an address another has, and lets an account be saved again', async () => {
      const store = await make();
      await store.saveUser(person('alice', 'same@example.com'));
      await expect(store.saveUser(person('bob', 'same@example.com'))).rejects.toMatchObject({ code: 11000 });
      await store.saveUser({ ...person('alice', 'same@example.com'), emailVerified: false });
      expect((await store.getUsers()).map((user) => user.id)).toEqual(['alice']);
    });

    it('finds an account by the provider that signs it in, issuer and subject together', async () => {
      const store = await make();
      await store.saveUser({ ...person('alice'), signInLinks: [{ issuer: 'https://one.example', subject: 'a-1' }, { issuer: 'https://two.example', subject: 'a-2' }] });
      await store.saveUser({ ...person('bob'), signInLinks: [{ issuer: 'https://one.example', subject: 'b-1' }] });
      await store.saveUser(person('carol'));
      expect((await store.getUserBySignInLink('https://two.example', 'a-2'))?.id).toBe('alice');
      expect((await store.getUserBySignInLink('https://one.example', 'b-1'))?.id).toBe('bob');
      expect(await store.getUserBySignInLink('https://one.example', 'a-2')).toBeUndefined();
      expect(await store.getUserBySignInLink('https://three.example', 'a-1')).toBeUndefined();
    });

    it('replaces everyone with the list it is given', async () => {
      const store = await make();
      await store.saveUser(person('alice'));
      await store.saveUser(person('bob'));
      await store.saveUserList([person('bob', 'bob2@example.com'), person('carol')]);
      expect((await store.getUsers()).map((user) => [user.id, user.email]).sort()).toEqual([['bob', 'bob2@example.com'], ['carol', 'carol@example.com']]);
      await store.saveUserList([]);
      expect(await store.getUsers()).toEqual([]);
    });

    it('turns every admin into an operator once, whatever roles they held, and says how many it moved', async () => {
      const store = await make();
      await store.saveUser(loose(person('boss'), { isAdmin: true }));
      await store.saveUser(loose(person('both'), { isAdmin: true, roles: ['operator'] }));
      await store.saveUser(loose(person('plain'), { isAdmin: false }));
      await store.saveUser(person('other'));
      expect(await store.grantOperatorToAdmins()).toBe(2);
      expect(await store.getUserById('boss')).toEqual({ ...person('boss'), roles: ['operator'] });
      expect(await store.getUserById('both')).toEqual({ ...person('both'), roles: ['operator'] });
      expect(await store.getUserById('plain')).toEqual(person('plain'));
      expect(await store.getUserById('other')).toEqual(person('other'));
      expect(await store.grantOperatorToAdmins()).toBe(0);
    });

    it('forgets the GitHub token an account saved under Cloud providers, keeping its other credentials, once', async () => {
      const store = await make();
      await store.saveUser(loose(person('both'), { credentials: { github: { token: 'sealed' }, huggingface: { hfToken: 'sealed-hf' } } }));
      await store.saveUser(loose(person('only'), { credentials: { github: { token: 'sealed', username: 'octo' } } }));
      await store.saveUser({ ...person('none'), credentials: { huggingface: { hfToken: 'sealed-hf' } } });
      expect(await store.dropGitHubCredentials()).toBe(2);
      expect(await store.getUserById('both')).toEqual({ ...person('both'), credentials: { huggingface: { hfToken: 'sealed-hf' } } });
      expect(await store.getUserById('only')).toEqual({ ...person('only'), credentials: {} });
      expect(await store.getUserById('none')).toEqual({ ...person('none'), credentials: { huggingface: { hfToken: 'sealed-hf' } } });
      expect(await store.dropGitHubCredentials()).toBe(0);
    });

    it('forgets models that are gone as anyone\'s default, leaving every other default and field as it was', async () => {
      const store = await make();
      await store.saveUser({ ...person('on-gone'), defaultModelId: 'gone-1', globalModelOverride: true });
      await store.saveUser({ ...person('on-other-gone'), defaultModelId: 'gone-2' });
      await store.saveUser({ ...person('on-kept'), defaultModelId: 'kept' });
      await store.saveUser(person('none'));
      await store.forgetDefaultModels(['gone-1', 'gone-2']);
      expect(await store.getUserById('on-gone')).toEqual({ ...person('on-gone'), globalModelOverride: true });
      expect(await store.getUserById('on-other-gone')).toEqual(person('on-other-gone'));
      expect(await store.getUserById('on-kept')).toEqual({ ...person('on-kept'), defaultModelId: 'kept' });
      expect(await store.getUserById('none')).toEqual(person('none'));
    });
  });

  describe('invites', () => {
    it('keeps an invite as it was saved, replaces it whole, and finds it by its code or its hash', async () => {
      const store = await make();
      const first = invite('i1', 'code-1', { email: 'a@example.com', expiresAt: '2030-01-01T00:00:00.000Z', project: { name: 'P', role: 'client', join: 'tok' }, makesAccount: true });
      await store.saveInvite(first);
      await store.saveInvite(invite('i2', 'code-2'));
      expect(await store.getInviteByCode('code-1')).toEqual(first);
      expect(await store.getInviteByHash(inviteCodeHash('code-2'))).toEqual(invite('i2', 'code-2'));
      expect(await store.getInviteByCode('code-3')).toBeUndefined();
      expect(await store.getInviteByHash('nothing')).toBeUndefined();
      await store.saveInvite({ ...first, email: 'b@example.com' });
      expect((await store.getInviteByCode('code-1'))?.email).toBe('b@example.com');
      expect((await store.getInvites()).map((held) => held.id).sort()).toEqual(['i1', 'i2']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveInvite(invite('i1', 'code-1', { project: { name: 'P', role: 'client', join: 'tok' } }));
      const read = await store.getInviteByCode('code-1');
      read!.createdBy = 'someone';
      read!.project!.name = 'changed';
      (await store.getInvites())[0]!.email = 'changed@example.com';
      expect(await store.getInviteByCode('code-1')).toEqual(invite('i1', 'code-1', { project: { name: 'P', role: 'client', join: 'tok' } }));
    });

    it('spends an invite once, by its code or its hash, and says who and when', async () => {
      const store = await make();
      await store.saveInvite(invite('i1', 'code-1'));
      await store.saveInvite(invite('i2', 'code-2'));
      expect(await store.claimInvite('code-1', 'alice', '2026-10-02T00:00:00.000Z')).toBe(true);
      expect(await store.claimInvite('code-1', 'bob', '2026-10-03T00:00:00.000Z')).toBe(false);
      expect(await store.getInviteByCode('code-1')).toMatchObject({ usedBy: 'alice', usedAt: '2026-10-02T00:00:00.000Z' });
      expect(await store.claimInviteByHash(inviteCodeHash('code-2'), 'bob', '2026-10-04T00:00:00.000Z')).toBe(true);
      expect(await store.claimInviteByHash(inviteCodeHash('code-2'), 'carol', '2026-10-05T00:00:00.000Z')).toBe(false);
      expect(await store.getInviteByCode('code-2')).toMatchObject({ usedBy: 'bob' });
      expect(await store.claimInvite('never-made', 'dave', '2026-10-06T00:00:00.000Z')).toBe(false);
    });

    it('leaves out a field saved as undefined, so an invite saved with an undefined usedBy can still be spent once', async () => {
      const store = await make();
      await store.saveInvite(loosely(invite('i1', 'code-1'), { usedBy: undefined, email: undefined }));
      const stored = await store.getInviteByCode('code-1');
      expect(stored).toEqual(invite('i1', 'code-1'));
      expect(stored).not.toHaveProperty('usedBy');
      expect(await store.claimInvite('code-1', 'alice', '2026-10-02T00:00:00.000Z')).toBe(true);
      expect(await store.claimInvite('code-1', 'bob', '2026-10-02T00:00:00.000Z')).toBe(false);
    });

    it('lets only one of several people spending the same invite at once have it', async () => {
      const store = await make();
      await store.saveInvite(invite('i1', 'code-1'));
      const won = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((who) => store.claimInvite('code-1', who, '2026-10-02T00:00:00.000Z')));
      expect(won.filter(Boolean)).toHaveLength(1);
      const winner = ['a', 'b', 'c', 'd', 'e'][won.indexOf(true)];
      expect((await store.getInviteByCode('code-1'))?.usedBy).toBe(winner);
    });

    it('makes the first account the first admin once, and lists that as an invite already used', async () => {
      const store = await make();
      const won = await Promise.all(['a', 'b', 'c', 'd'].map((who) => store.claimFirstAdmin(who, '2026-10-02T00:00:00.000Z')));
      expect(won.filter(Boolean)).toHaveLength(1);
      const winner = ['a', 'b', 'c', 'd'][won.indexOf(true)];
      expect(await store.claimFirstAdmin('late', '2026-10-03T00:00:00.000Z')).toBe(false);
      expect(await store.getInvites()).toEqual([{ id: 'first-admin', createdBy: 'setup', createdAt: '2026-10-02T00:00:00.000Z', usedBy: winner, usedAt: '2026-10-02T00:00:00.000Z' }]);
    });

    it('turns invites saved with their code into ones held by hash, expiring the unused, and says how many', async () => {
      const store = await make();
      await store.saveInvite({ id: 'plain', code: 'secret-1', createdBy: 'owner-1', createdAt: '2026-10-01T00:00:00.000Z' });
      await store.saveInvite({ id: 'dated', code: 'secret-2', createdBy: 'owner-1', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' });
      await store.saveInvite({ id: 'used', code: 'secret-3', createdBy: 'owner-1', createdAt: '2026-10-01T00:00:00.000Z', usedBy: 'alice', usedAt: '2026-10-02T00:00:00.000Z' });
      await store.saveInvite(invite('hashed', 'secret-4'));
      expect(await store.hashInviteCodes('2026-12-01T00:00:00.000Z')).toBe(3);
      expect(await store.getInviteByCode('secret-1')).toEqual({ id: 'plain', codeHash: inviteCodeHash('secret-1'), createdBy: 'owner-1', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z' });
      expect(await store.getInviteByCode('secret-2')).toMatchObject({ id: 'dated', expiresAt: '2027-01-01T00:00:00.000Z' });
      expect(await store.getInviteByCode('secret-3')).toEqual({ id: 'used', codeHash: inviteCodeHash('secret-3'), createdBy: 'owner-1', createdAt: '2026-10-01T00:00:00.000Z', usedBy: 'alice', usedAt: '2026-10-02T00:00:00.000Z' });
      expect(await store.getInviteByCode('secret-4')).toEqual(invite('hashed', 'secret-4'));
      expect(await store.hashInviteCodes('2026-12-01T00:00:00.000Z')).toBe(0);
    });

    it('holds the limits on project invites as saved, and none until they are', async () => {
      const store = await make();
      expect(await store.getInviteLimits()).toBeUndefined();
      await store.saveInviteLimits({ accounts: 4, perHour: 7 });
      expect(await store.getInviteLimits()).toEqual({ accounts: 4, perHour: 7 });
      await store.saveInviteLimits({ accounts: 0, perHour: 1 });
      expect(await store.getInviteLimits()).toEqual({ accounts: 0, perHour: 1 });
    });
  });

  emailedCodeContract<PendingSignUp>({
    noun: 'sign-ups waiting for their emailed code',
    most: SIGN_UP_CODES_SENT,
    make: signUp,
    save: (store, row) => store.savePendingSignUp(row),
    get: (store, id) => store.getPendingSignUp(id),
    wrong: (store, id) => store.wrongSignUpCode(id),
    resend: (store, id, codeHash, expiresAt) => store.newSignUpCode(id, codeHash, expiresAt),
    remove: (store, id) => store.deletePendingSignUp(id),
  }, make);

  emailedCodeContract<PasswordReset>({
    noun: 'password resets waiting for their emailed code',
    most: RESET_CODES_SENT,
    make: reset,
    save: (store, row) => store.savePasswordReset(row),
    get: (store, id) => store.getPasswordReset(id),
    wrong: (store, id) => store.wrongResetCode(id),
    resend: (store, id, codeHash, expiresAt) => store.newResetCode(id, codeHash, expiresAt),
    remove: (store, id) => store.deletePasswordReset(id),
  }, make);

  describe('two-factor codes', () => {
    it('keeps a code as it was saved, replaces it when saved again, and hands back a copy', async () => {
      const store = await make();
      await store.saveTwoFactorCode(twoFactor('sign-in:alice', 'alice'));
      expect(await store.getTwoFactorCode('sign-in:alice')).toEqual(twoFactor('sign-in:alice', 'alice'));
      expect(await store.getTwoFactorCode('sign-in:bob')).toBeUndefined();
      await store.saveTwoFactorCode({ ...twoFactor('sign-in:alice', 'alice'), codeHash: 'h2' });
      const read = await store.getTwoFactorCode('sign-in:alice');
      expect(read?.codeHash).toBe('h2');
      read!.expiresAt.setUTCFullYear(1999);
      expect(await store.getTwoFactorCode('sign-in:alice')).toEqual({ ...twoFactor('sign-in:alice', 'alice'), codeHash: 'h2' });
    });

    it('hands a code out once, however many ask at once', async () => {
      const store = await make();
      await store.saveTwoFactorCode(twoFactor('confirm:alice', 'alice'));
      const taken = await Promise.all([1, 2, 3, 4].map(() => store.takeTwoFactorCode('confirm:alice')));
      expect(taken.filter(Boolean)).toHaveLength(1);
      expect(await store.getTwoFactorCode('confirm:alice')).toBeUndefined();
      expect(await store.takeTwoFactorCode('confirm:alice')).toBe(false);
    });

    it('drops every code of one person and no one else\'s', async () => {
      const store = await make();
      await store.saveTwoFactorCode(twoFactor('sign-in:alice', 'alice'));
      await store.saveTwoFactorCode(twoFactor('confirm:alice', 'alice'));
      await store.saveTwoFactorCode(twoFactor('sign-in:bob', 'bob'));
      await store.dropTwoFactorCodesOf('alice');
      await store.dropTwoFactorCodesOf('nobody');
      expect(await store.getTwoFactorCode('sign-in:alice')).toBeUndefined();
      expect(await store.getTwoFactorCode('confirm:alice')).toBeUndefined();
      expect(await store.getTwoFactorCode('sign-in:bob')).toEqual(twoFactor('sign-in:bob', 'bob'));
    });
  });

  describe('removing an account', () => {
    it('finds nothing of the account\'s work among the records it keeps itself', async () => {
      const store = await make();
      await store.saveUser(person('alice'));
      expect(await store.accountIds('alice')).toEqual({ runIds: [], treeIds: [], conversationIds: [], proposalIds: [], projectIds: [], buildWorkflowIds: [], ingestIds: [] });
    });

    it('counts what is left of an account, and removes it, in the records it keeps', async () => {
      const store = await make();
      await store.saveUser(person('alice'));
      await store.saveUser(person('bob'));
      await store.saveTwoFactorCode(twoFactor('sign-in:alice', 'alice'));
      await store.saveTwoFactorCode(twoFactor('confirm:alice', 'alice'));
      await store.saveTwoFactorCode(twoFactor('sign-in:bob', 'bob'));
      await store.savePasswordReset(reset('r-alice'));
      await store.savePasswordReset({ ...reset('r-bob'), ownerId: 'bob' });
      await store.savePasswordReset({ id: 'r-nobody', email: 'x@example.com', codeHash: 'c', wrong: 0, sent: 1, expiresAt: later(0) });
      await store.saveInvite(invite('i1', 'code-1', { createdBy: 'alice' }));
      await store.savePendingSignUp(signUp('s1'));
      expect(await store.accountLeftovers('alice')).toEqual({ twoFactorCodes: 2, users: 1 });
      expect(await store.accountLeftovers('owner-1')).toEqual({ passwordResets: 1 });
      expect(await store.accountLeftovers('nobody')).toEqual({});
      expect(await store.removeAccountRecords('alice', nothingRelated)).toEqual({ twoFactorCodes: 2, users: 1 });
      expect(await store.accountLeftovers('alice')).toEqual({});
      expect(await store.getUserById('alice')).toBeUndefined();
      expect(await store.getUserById('bob')).toEqual(person('bob'));
      expect(await store.getTwoFactorCode('sign-in:bob')).toBeDefined();
      expect(await store.getPasswordReset('r-bob')).toBeDefined();
      expect(await store.getInviteByCode('code-1')).toBeDefined();
      expect(await store.getPendingSignUp('s1')).toBeDefined();
      expect(await store.removeAccountRecords('owner-1', nothingRelated)).toEqual({ passwordResets: 1 });
      expect(await store.removeAccountRecords('nobody', nothingRelated)).toEqual({});
    });
  });
}
