import { randomUUID } from 'crypto';
import webPush from 'web-push';
import type { MonitoringStore } from '../store.js';
import {
  TEST_PUSH, deviceLabel, gone, pushPayload, subscriptionProblem,
  type PushDevice, type PushKeys, type PushMessage, type PushSubscriptionRecord, type VapidKeys,
} from '../lib/web-push.js';

export type PushSend = (subscription: { endpoint: string; keys: PushKeys }, payload: string) => Promise<void>;

export interface PushView {
  publicKey: string;
  devices: PushDevice[];
}

export interface PushServiceDeps {
  store: Pick<MonitoringStore, 'getPushSubscriptions' | 'savePushSubscription' | 'deletePushSubscription'>;
  vapid: VapidKeys;
  send: PushSend;
  now?: () => string;
  log?: (message: string) => void;
}

export class PushError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const webPushSend = (vapid: VapidKeys, subject: string): PushSend => async (subscription, payload) => {
  await webPush.sendNotification(subscription, payload, { vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 24 * 60 * 60 });
};

const statusOf = (err: unknown): unknown => (err as { statusCode?: unknown }).statusCode;

export class PushService {
  constructor(private readonly deps: PushServiceDeps) {}

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }

  async view(ownerId: string): Promise<PushView> {
    const devices = await this.deps.store.getPushSubscriptions(ownerId);
    return { publicKey: this.deps.vapid.publicKey, devices: devices.map(({ id, label, createdAt }) => ({ id, label, createdAt })) };
  }

  async subscribe(ownerId: string, raw: unknown, userAgent: string | undefined): Promise<PushView> {
    const problem = subscriptionProblem(raw);
    if (problem) throw new PushError(400, problem);
    const subscription = raw as { endpoint: string; keys: PushKeys };
    const record: PushSubscriptionRecord = {
      id: randomUUID(),
      ownerId,
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      label: deviceLabel(userAgent),
      createdAt: (this.deps.now ?? (() => new Date().toISOString()))(),
    };
    await this.deps.store.savePushSubscription(record);
    return this.view(ownerId);
  }

  async remove(ownerId: string, id: string): Promise<PushView> {
    if (!await this.deps.store.deletePushSubscription(ownerId, id)) throw new PushError(404, 'no device of yours has that id');
    return this.view(ownerId);
  }

  async test(ownerId: string): Promise<{ sent: number }> {
    const sent = await this.toPerson(ownerId, TEST_PUSH);
    if (sent === 0) throw new PushError(409, 'no device of yours is set to be notified; switch it on on this device first');
    return { sent };
  }

  async toPerson(ownerId: string, message: PushMessage): Promise<number> {
    const subscriptions = await this.deps.store.getPushSubscriptions(ownerId);
    const payload = pushPayload(message);
    let sent = 0;
    for (const subscription of subscriptions) {
      try {
        await this.deps.send({ endpoint: subscription.endpoint, keys: subscription.keys }, payload);
        sent += 1;
      } catch (err) {
        if (gone(statusOf(err))) {
          await this.deps.store.deletePushSubscription(ownerId, subscription.id);
          this.log(`[push] ${subscription.label} of ${ownerId} unsubscribed; it is forgotten`);
        } else {
          this.log(`[push] could not reach ${subscription.label} of ${ownerId}: ${(err as Error).message}`);
        }
      }
    }
    return sent;
  }
}
