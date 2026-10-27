import { randomUUID } from 'node:crypto';
import { inviteCodeHash, inviteExpired, inviteExpiry, newInviteCode, type InviteMetadata, type MailMessage } from '../../platform/index.js';
import { joinLink, projectInviteMail } from '../lib/project-invite-mail.js';
import { DEFAULT_INVITE_LIMITS, projectInviteRefusal, type InviteLimits } from '../../accounts/index.js';

export interface ProjectInviteDeps {
  invites: { getInviteByCode(code: string): Promise<InviteMetadata | undefined>; saveInvite(invite: InviteMetadata): Promise<void>; getInvites(): Promise<InviteMetadata[]> };
  people: { getUserById(id: string): Promise<{ id: string; isAdmin?: boolean | undefined; inviteAccounts?: number | undefined } | undefined>; getUserByEmail(email: string): Promise<unknown> };
  limits: () => Promise<Partial<InviteLimits> | undefined>;
  mail?: { available(): { ok: true } | { ok: false; why: string }; toAddress(to: string, message: MailMessage): Promise<void> } | undefined;
  rootUrl: string;
  now?: (() => string) | undefined;
}

export interface ProjectInviteRequest {
  email: string;
  inviterId: string;
  inviterEmail: string;
  projectName: string;
  role: string;
  join: string;
}

export interface ProjectInviteSent {
  link: string;
  emailed: boolean;
  why?: string | undefined;
}

export type ProjectInviteOutcome = ProjectInviteSent | { refused: string };

export class ProjectInviteService {
  constructor(private readonly deps: ProjectInviteDeps) {}

  async send(request: ProjectInviteRequest): Promise<ProjectInviteOutcome> {
    const createdAt = this.deps.now?.() ?? new Date().toISOString();
    const email = request.email.trim().toLowerCase();
    const inviter = await this.deps.people.getUserById(request.inviterId);
    if (!inviter) return { refused: 'Koala does not know who is inviting.' };
    const makesAccount = !(await this.deps.people.getUserByEmail(email));
    const limits = { ...DEFAULT_INVITE_LIMITS, ...(await this.deps.limits()) };
    const refused = projectInviteRefusal(await this.deps.invites.getInvites(), inviter, limits, makesAccount, new Date(createdAt));
    if (refused) return { refused };
    const code = newInviteCode();
    await this.deps.invites.saveInvite({
      id: randomUUID(),
      codeHash: inviteCodeHash(code),
      createdBy: request.inviterId,
      createdAt,
      expiresAt: inviteExpiry(new Date(createdAt)),
      email,
      project: { name: request.projectName, role: request.role, join: request.join },
      makesAccount,
    });
    const link = joinLink(this.deps.rootUrl, code, request.join);
    const available = this.deps.mail?.available() ?? { ok: false as const, why: 'this root sends no email' };
    if (!available.ok) return { link, emailed: false, why: available.why };
    try {
      await this.deps.mail!.toAddress(request.email, projectInviteMail({ inviterEmail: request.inviterEmail, projectName: request.projectName, role: request.role, link }));
      return { link, emailed: true };
    } catch (err) {
      return { link, emailed: false, why: (err as Error).message };
    }
  }

  async invitation(code: string): Promise<{ email?: string | undefined; project?: InviteMetadata['project']; used: boolean } | undefined> {
    const invite = await this.deps.invites.getInviteByCode(code);
    return invite?.project && !inviteExpired(invite, new Date()) ? { ...(invite.email ? { email: invite.email } : {}), ...(invite.project ? { project: invite.project } : {}), used: Boolean(invite.usedBy) } : undefined;
  }
}
