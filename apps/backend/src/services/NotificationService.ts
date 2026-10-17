import type { Database } from '../lib/db-interface.js';
import { DEFAULT_EMAIL, alertMail, emailWanted, isEmailChoice, type EmailChoice, type NotificationSettings } from '../lib/mail.js';
import type { AlertEpisode } from '../lib/monitoring-records.js';
import type { MailService } from './MailService.js';

export interface NotificationView {
  email: EmailChoice;
  available: { ok: true } | { ok: false; why: string };
}

export class NotificationService {
  constructor(private readonly deps: {
    store: Pick<Database, 'getNotificationSettings' | 'saveNotificationSettings'>;
    mail: Pick<MailService, 'available' | 'toOwner'>;
    publicUrl?: string | undefined;
    now?: () => string;
    log?: (message: string) => void;
  }) {}

  async choiceOf(ownerId: string): Promise<EmailChoice> {
    return (await this.deps.store.getNotificationSettings(ownerId))?.email ?? DEFAULT_EMAIL;
  }

  async view(ownerId: string): Promise<NotificationView> {
    return { email: await this.choiceOf(ownerId), available: this.deps.mail.available() };
  }

  async set(ownerId: string, email: unknown): Promise<{ ok: true; value: NotificationView } | { ok: false; error: string }> {
    if (!isEmailChoice(email)) return { ok: false, error: 'email is off, all or down' };
    const settings: NotificationSettings = { ownerId, email, updatedAt: (this.deps.now ?? (() => new Date().toISOString()))() };
    await this.deps.store.saveNotificationSettings(settings);
    return { ok: true, value: await this.view(ownerId) };
  }

  async alert(episode: AlertEpisode, change: 'fired' | 'resolved'): Promise<boolean> {
    if (!this.deps.mail.available().ok) return false;
    if (!emailWanted(await this.choiceOf(episode.ownerId), episode)) return false;
    await this.deps.mail.toOwner(episode.ownerId, alertMail(episode, change, this.deps.publicUrl));
    return true;
  }
}
