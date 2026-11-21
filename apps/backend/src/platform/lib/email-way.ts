import type { RoleConfig } from './platform-role.js';
import { mailFrom } from './mail.js';

export type EmailWay =
  | { kind: 'smtp'; url: string; from: string }
  | { kind: 'root'; rootUrl: string; instanceId: string }
  | { kind: 'none'; why: string };

export function emailWayFrom(env: Readonly<Record<string, string | undefined>>, role: Pick<RoleConfig, 'role' | 'instance'>): EmailWay {
  if (role.role === 'instance' && role.instance) return { kind: 'root', rootUrl: role.instance.rootUrl, instanceId: role.instance.id };
  const url = env.MAIL_SMTP_URL?.trim();
  if (!url) return { kind: 'none', why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' };
  const from = env.MAIL_FROM?.trim();
  const domain = env.DOMAIN?.trim();
  if (!from && !domain) throw new Error('MAIL_SMTP_URL is set, but neither MAIL_FROM nor DOMAIN is, so mail would go out from no address of this platform\'s');
  return { kind: 'smtp', url, from: from ?? mailFrom(domain!) };
}
