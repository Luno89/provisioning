import type { AlertEpisode } from '../../monitoring/lib/monitoring-records.js';

export interface MailMessage {
  subject: string;
  text: string;
}

export const EMAIL_CHOICES = ['off', 'all', 'down'] as const;
export type EmailChoice = typeof EMAIL_CHOICES[number];

export interface NotificationSettings {
  ownerId: string;
  email: EmailChoice;
  updatedAt: string;
}

export const DEFAULT_EMAIL: EmailChoice = 'all';

export const isEmailChoice = (value: unknown): value is EmailChoice => typeof value === 'string' && (EMAIL_CHOICES as readonly string[]).includes(value);

const DOWN_ALERTS: ReadonlySet<string> = new Set(['AppProbeDown', 'Koala_down', 'KubeNodeNotReady', 'KubeNodeUnreachable']);

export function emailWanted(choice: EmailChoice, episode: Pick<AlertEpisode, 'name'>): boolean {
  if (choice === 'off') return false;
  if (choice === 'all') return true;
  return DOWN_ALERTS.has(episode.name);
}

export function alertMail(episode: AlertEpisode, change: 'fired' | 'resolved', publicUrl: string | undefined): MailMessage {
  const about = episode.about.kind === 'app' ? `app/${episode.about.deploymentId}` : `cluster/${episode.clusterId}`;
  const link = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/#/monitoring/${about}` : undefined;
  return change === 'fired'
    ? {
      subject: `Alert: ${episode.summary}`,
      text: [`${episode.summary}.`, `It started at ${episode.startedAt}.`, ...(link ? ['', `See its health: ${link}`] : []), '', 'You get these because email alerts are on in Settings → Notifications.'].join('\n'),
    }
    : {
      subject: `Resolved: ${episode.summary}`,
      text: [`${episode.summary}: resolved at ${episode.resolvedAt ?? 'now'}.`, `It started at ${episode.startedAt}.`, ...(link ? ['', `See its health: ${link}`] : []), '', 'You get these because email alerts are on in Settings → Notifications.'].join('\n'),
    };
}

export const TEST_MAIL: MailMessage = {
  subject: 'Koala can email you',
  text: 'This is the test email you asked for from Settings → Notifications. Alerts will arrive like this.',
};

export function mailProblem(body: { subject?: unknown; text?: unknown }): string | undefined {
  if (typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 200) return 'subject is text of up to 200 characters';
  if (/[\r\n]/.test(body.subject)) return 'subject is one line';
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000) return 'text is up to 20000 characters';
  return undefined;
}

export const mailFrom = (domain: string): string => `Koala <alerts@${domain}>`;
