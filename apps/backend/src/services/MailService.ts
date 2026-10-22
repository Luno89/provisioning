import nodemailer from 'nodemailer';
import type { MailMessage } from '../lib/mail.js';

import type { EmailWay } from '../lib/email-way.js';

export type { EmailWay };

export interface MailDeps {
  way: EmailWay;
  emailOf(ownerId: string): Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  transport?: (url: string) => { sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
}

export class MailError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class MailService {
  private readonly smtp: { sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> } | undefined;

  constructor(private readonly deps: MailDeps) {
    this.smtp = deps.way.kind === 'smtp' ? (deps.transport ?? ((url) => nodemailer.createTransport(url)))(deps.way.url) : undefined;
  }

  available(): { ok: true } | { ok: false; why: string } {
    return this.deps.way.kind === 'none' ? { ok: false, why: this.deps.way.why } : { ok: true };
  }

  async toAddress(to: string, message: MailMessage): Promise<void> {
    const way = this.deps.way;
    if (way.kind !== 'smtp') throw new MailError(503, way.kind === 'none' ? way.why : 'only root sends email to other people');
    await this.smtp!.sendMail({ from: way.from, to, subject: message.subject, text: message.text });
  }

  async toOwner(ownerId: string, message: MailMessage): Promise<void> {
    const way = this.deps.way;
    if (way.kind === 'none') throw new MailError(503, way.why);
    if (way.kind === 'root') {
      const response = await (this.deps.fetchImpl ?? fetch)(`${way.rootUrl}/api/instances/mail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-instance-id': way.instanceId, authorization: `Bearer ${way.credential}` },
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        const answer = await response.json().catch(() => ({})) as { error?: unknown };
        throw new MailError(502, `root did not send it (${response.status}): ${typeof answer.error === 'string' ? answer.error : 'no reason given'}`);
      }
      return;
    }
    const to = await this.deps.emailOf(ownerId);
    if (!to) throw new MailError(404, 'this account has no email address');
    await this.smtp!.sendMail({ from: way.from, to, subject: message.subject, text: message.text });
  }
}
