import type { NotificationSettings } from '../../platform/index.js';
import { collectionIn, copied, MemoryRecords, type Collections } from '../../platform/testing/memory-records.js';
import type { AlertRuleRecord } from '../lib/monitoring-alerts.js';
import type { AlertEpisode, MonitoringSetting } from '../lib/monitoring-records.js';
import type { PushSubscriptionRecord } from '../lib/web-push.js';
import type { MonitoringStore } from '../store.js';

export class MemoryMonitoringStore implements MonitoringStore {
  private readonly monitoringSettings: Map<string, MonitoringSetting>;
  private readonly notificationSettings: Map<string, NotificationSettings>;
  private readonly rules: MemoryRecords<AlertRuleRecord>;
  private readonly episodes: MemoryRecords<AlertEpisode>;
  private readonly subscriptions: MemoryRecords<PushSubscriptionRecord>;

  constructor(collections: Collections = new Map()) {
    this.monitoringSettings = collectionIn<MonitoringSetting>(collections, 'monitoringSettings');
    this.notificationSettings = collectionIn<NotificationSettings>(collections, 'notificationSettings');
    this.rules = new MemoryRecords(collectionIn<AlertRuleRecord>(collections, 'monitoringAlertRules'));
    this.episodes = new MemoryRecords(collectionIn<AlertEpisode>(collections, 'monitoringAlertEpisodes'));
    this.subscriptions = new MemoryRecords(collectionIn<PushSubscriptionRecord>(collections, 'pushSubscriptions'));
  }

  async ensureIndexes(): Promise<void> {}

  async getMonitoringSettings(): Promise<MonitoringSetting[]> {
    return [...this.monitoringSettings.values()].map(copied);
  }

  async saveMonitoringSetting(setting: MonitoringSetting): Promise<void> {
    this.monitoringSettings.set(setting.clusterId, copied(setting));
  }

  async getNotificationSettings(ownerId: string): Promise<NotificationSettings | undefined> {
    const stored = this.notificationSettings.get(ownerId);
    return stored ? copied(stored) : undefined;
  }

  async saveNotificationSettings(settings: NotificationSettings): Promise<void> {
    this.notificationSettings.set(settings.ownerId, copied(settings));
  }

  async getAlertRules(ownerId?: string): Promise<AlertRuleRecord[]> {
    return this.rules.all().filter((rule) => ownerId === undefined || rule.ownerId === ownerId);
  }

  async saveAlertRule(rule: AlertRuleRecord): Promise<void> {
    this.rules.put(rule);
  }

  async deleteAlertRule(id: string): Promise<void> {
    this.rules.delete(id);
  }

  async getAlertEpisodes(ownerId?: string): Promise<AlertEpisode[]> {
    return this.episodes
      .all()
      .filter((episode) => ownerId === undefined || episode.ownerId === ownerId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  async saveAlertEpisode(episode: AlertEpisode): Promise<void> {
    this.episodes.put(episode);
  }

  async getPushSubscriptions(ownerId: string): Promise<PushSubscriptionRecord[]> {
    return this.subscriptions
      .all()
      .filter((subscription) => subscription.ownerId === ownerId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async savePushSubscription(subscription: PushSubscriptionRecord): Promise<void> {
    const same = this.subscriptions.all().find((other) => other.ownerId === subscription.ownerId && other.endpoint === subscription.endpoint);
    if (same) {
      this.subscriptions.put({ ...same, keys: subscription.keys, label: subscription.label });
      return;
    }
    if (this.subscriptions.get(subscription.id)) throw new Error('E11000 duplicate key error: a push subscription already has this id');
    this.subscriptions.put(subscription);
  }

  async deletePushSubscription(ownerId: string, id: string): Promise<boolean> {
    const stored = this.subscriptions.get(id);
    return stored?.ownerId === ownerId ? this.subscriptions.delete(id) : false;
  }
}
