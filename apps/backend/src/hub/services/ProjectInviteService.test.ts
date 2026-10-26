import { describe, expect, it, vi } from 'vitest';
import { ProjectInviteService } from './ProjectInviteService.js';
import type { InviteMetadata } from '../../platform/lib/types.js';
import { inviteCodeHash } from '../../platform/lib/invite-codes.js';

function setUp(mail: 'works' | 'off' | 'fails') {
  const invites: InviteMetadata[] = [];
  const toAddress = vi.fn(async () => { if (mail === 'fails') throw new Error('the mail server refused it'); });
  const service = new ProjectInviteService({
    invites: { getInviteByCode: async (code) => invites.find((invite) => invite.codeHash === inviteCodeHash(code)), saveInvite: async (invite) => { invites.push(invite); } },
    mail: { available: () => (mail === 'off' ? { ok: false as const, why: 'MAIL_SMTP_URL is not set' } : { ok: true as const }), toAddress },
    rootUrl: 'http://koala.localhost:5175/',
    now: () => '2026-10-26T12:00:00.000Z',
  });
  return { service, invites, toAddress };
}

const asked = { email: ' Cy@Example.com ', inviterId: 'ann', inviterEmail: 'ann@example.com', projectName: 'Shop', role: 'client', join: 'J'.repeat(32) };

describe('inviting someone to a project, on root', () => {
  it('makes an invite code only that address can sign up with, and emails the link root wrote', async () => {
    const { service, invites, toAddress } = setUp('works');
    const sent = await service.send(asked);
    expect(invites[0]).toMatchObject({ email: 'cy@example.com', createdBy: 'ann', project: { name: 'Shop', role: 'client', join: 'J'.repeat(32) } });
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
});
