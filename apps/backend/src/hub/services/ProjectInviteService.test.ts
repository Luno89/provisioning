import { describe, expect, it, vi } from 'vitest';
import { ProjectInviteService } from './ProjectInviteService.js';
import type { InviteMetadata } from '../../platform/lib/types.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';

function setUp(mail: 'works' | 'off' | 'fails', over: { limits?: { accounts?: number; perHour?: number }; people?: Record<string, { isAdmin?: boolean; inviteAccounts?: number }>; accounts?: string[]; now?: () => string } = {}) {
  const invites: InviteMetadata[] = [];
  const toAddress = vi.fn(async () => { if (mail === 'fails') throw new Error('the mail server refused it'); });
  const people = { ann: {}, ...(over.people ?? {}) } as Record<string, { isAdmin?: boolean; inviteAccounts?: number }>;
  const service = new ProjectInviteService({
    invites: { getInviteByCode: async (code) => invites.find((invite) => invite.codeHash === inviteCodeHash(code)), saveInvite: async (invite) => { invites.push(invite); }, getInvites: async () => invites },
    people: { getUserById: async (id) => (people[id] ? { id, ...people[id] } : undefined), getUserByEmail: async (email) => ((over.accounts ?? []).includes(email) ? { email } : undefined) },
    limits: async () => over.limits,
    mail: { available: () => (mail === 'off' ? { ok: false as const, why: 'MAIL_SMTP_URL is not set' } : { ok: true as const }), toAddress },
    rootUrl: 'http://koala.localhost:5175/',
    now: over.now ?? (() => '2026-10-26T12:00:00.000Z'),
  });
  return { service, invites, toAddress };
}

const asked = { email: ' Cy@Example.com ', inviterId: 'ann', inviterEmail: 'ann@example.com', projectName: 'Shop', role: 'client', join: 'J'.repeat(32) };

describe('inviting someone to a project, on root', () => {
  it('makes an invite code only that address can sign up with, and emails the link root wrote', async () => {
    const { service, invites, toAddress } = setUp('works');
    const sent = await service.send(asked);
    if ('refused' in sent) throw new Error(sent.refused);
    expect(invites[0]).toMatchObject({ email: 'cy@example.com', createdBy: 'ann', project: { name: 'Shop', role: 'client', join: 'J'.repeat(32) }, makesAccount: true });
    const code = new URLSearchParams(sent.link.split('?')[1]).get('code')!;
    expect(invites[0]!.codeHash).toBe(inviteCodeHash(code));
    expect(invites[0]).not.toHaveProperty('code');
    expect(invites[0]!.expiresAt).toBe('2026-11-09T12:00:00.000Z');
    expect(sent).toEqual({ link: `http://koala.localhost:5175/#/join?code=${encodeURIComponent(code)}&project=${'J'.repeat(32)}`, emailed: true });
    const [to, message] = toAddress.mock.calls[0] as unknown as [string, { subject: string; text: string }];
    expect(to).toBe(' Cy@Example.com ');
    expect(message.subject).toBe('ann@example.com invited you to Shop on Koala');
    expect(message.text).toContain(sent.link);
    expect(message.text).toContain('as a client, who sees how it is going and asks for changes');
    expect(await service.invitation(code)).toEqual({ email: 'cy@example.com', project: { name: 'Shop', role: 'client', join: 'J'.repeat(32) }, used: false });
    invites.push({ id: 'admin-made', codeHash: inviteCodeHash('ADMINCODE'), createdBy: 'an-admin', createdAt: '2026-10-26T12:00:00.000Z' });
    expect(await service.invitation('ADMINCODE')).toBeUndefined();
  });

  it('still gives the link to pass on by hand when email is off or fails, and says why', async () => {
    expect(await setUp('off').service.send(asked)).toMatchObject({ emailed: false, why: 'MAIL_SMTP_URL is not set' });
    expect(await setUp('fails').service.send(asked)).toMatchObject({ emailed: false, why: 'the mail server refused it' });
  });

  it('lets one person\'s invites bring only so many new people to Koala, counting none to someone who already has an account', async () => {
    const { service, invites } = setUp('off', { limits: { accounts: 2 }, accounts: ['bo@example.com'] });
    for (const email of ['a@example.com', 'b@example.com']) expect(await service.send({ ...asked, email })).toMatchObject({ emailed: false });
    expect(await service.send({ ...asked, email: 'c@example.com' })).toEqual({ refused: 'Your project invites have brought 2 new people to Koala, as many as you may (2); an admin can raise it, or invite someone who already has an account.' });
    expect(await service.send({ ...asked, email: 'bo@example.com' })).toMatchObject({ emailed: false });
    expect(invites.map((invite) => [invite.email, invite.makesAccount])).toEqual([['a@example.com', true], ['b@example.com', true], ['bo@example.com', false]]);
    invites[0]!.expiresAt = '2026-10-01T00:00:00.000Z';
    expect(await service.send({ ...asked, email: 'c@example.com' })).toMatchObject({ emailed: false });
  });

  it('takes a person\'s own allowance over the default, and limits none for an admin', async () => {
    const own = setUp('off', { limits: { accounts: 0 }, people: { ann: { inviteAccounts: 1 } } });
    expect(await own.service.send(asked)).toMatchObject({ emailed: false });
    expect(await own.service.send({ ...asked, email: 'z@example.com' })).toMatchObject({ refused: expect.stringMatching(/as many as you may \(1\)/) });
    const admin = setUp('off', { limits: { accounts: 0, perHour: 1 }, people: { ann: { isAdmin: true } } });
    for (const email of ['a@example.com', 'b@example.com']) expect(await admin.service.send({ ...asked, email })).toMatchObject({ emailed: false });
  });

  it('sends only so many invites an hour, and says when the next may go', async () => {
    let at = '2026-10-26T12:00:00.000Z';
    const { service } = setUp('off', { limits: { perHour: 2, accounts: 100 }, now: () => at });
    expect(await service.send({ ...asked, email: 'a@example.com' })).toMatchObject({ emailed: false });
    at = '2026-10-26T12:20:00.000Z';
    expect(await service.send({ ...asked, email: 'b@example.com' })).toMatchObject({ emailed: false });
    expect(await service.send({ ...asked, email: 'c@example.com' })).toEqual({ refused: 'You have sent 2 project invites in the last hour, the most an hour allows; try again in 40 minutes.' });
    at = '2026-10-26T13:00:01.000Z';
    expect(await service.send({ ...asked, email: 'c@example.com' })).toMatchObject({ emailed: false });
  });

  it('refuses an invite from someone root does not know', async () => {
    expect(await setUp('off').service.send({ ...asked, inviterId: 'ghost' })).toEqual({ refused: 'Koala does not know who is inviting.' });
  });
});
