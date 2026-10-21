import { randomBytes, randomUUID } from 'node:crypto';
import type { InviteMetadata } from '../lib/types.js';
import { joinLink, projectInviteMail } from '../lib/project-invite-mail.js';
import type { MailMessage } from '../lib/mail.js';

export interface ProjectInviteDeps {
  invites: { getInvites(): Promise<InviteMetadata[]>; saveInvite(invite: InviteMetadata): Promise<void> };
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

export class ProjectInviteService {
  constructor(private readonly deps: ProjectInviteDeps) {}

  async send(request: ProjectInviteRequest): Promise<ProjectInviteSent> {
    const code = randomBytes(18).toString('base64url');
    await this.deps.invites.saveInvite({
      id: randomUUID(),
      code,
      createdBy: request.inviterId,
      createdAt: this.deps.now?.() ?? new Date().toISOString(),
      email: request.email.trim().toLowerCase(),
      project: { name: request.projectName, role: request.role, join: request.join },
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
    const invite = (await this.deps.invites.getInvites()).find((entry) => entry.code === code);
    return invite ? { ...(invite.email ? { email: invite.email } : {}), ...(invite.project ? { project: invite.project } : {}), used: Boolean(invite.usedBy) } : undefined;
  }
}
