import type { RoleConfig } from './platform-role.js';
import { mailFrom } from './mail.js';

export type EmailWay =
  | { kind: 'smtp'; url: string; from: string }
  | { kind: 'root'; rootUrl: string; instanceId: string; credential: string }
  | { kind: 'none'; why: string };

export function emailWayFrom(env: Readonly<Record<string, string | undefined>>, role: Pick<RoleConfig, 'role' | 'instance'>): EmailWay {
  if (role.role === 'instance' && role.instance) {
    const credential = env.INSTANCE_CREDENTIAL?.trim();
    return credential
      ? { kind: 'root', rootUrl: role.instance.rootUrl, instanceId: role.instance.id, credential }
      : { kind: 'none', why: 'this instance has no credential for its root, so it cannot ask root to send email' };
  }
  const url = env.MAIL_SMTP_URL?.trim();
  if (!url) return { kind: 'none', why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' };
  const domain = env.INGRESS_DOMAIN?.trim() || 'localhost';
  return { kind: 'smtp', url, from: env.MAIL_FROM?.trim() || mailFrom(domain) };
}
