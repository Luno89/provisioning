import type { AlertEpisode, MonitoringSetting } from './lib/monitoring-records.js';
import type { AlertRuleRecord } from './lib/monitoring-alerts.js';
import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Db } from 'mongodb';
import type { NotificationSettings } from '../platform/lib/mail.js';

export interface MonitoringStore extends AreaStore {
  getMonitoringSettings(): Promise<MonitoringSetting[]>;
  getNotificationSettings(ownerId: string): Promise<NotificationSettings | undefined>;
  saveNotificationSettings(settings: NotificationSettings): Promise<void>;
  saveMonitoringSetting(setting: MonitoringSetting): Promise<void>;
  getAlertRules(ownerId?: string): Promise<AlertRuleRecord[]>;
  saveAlertRule(rule: AlertRuleRecord): Promise<void>;
  deleteAlertRule(id: string): Promise<void>;
  getAlertEpisodes(ownerId?: string): Promise<AlertEpisode[]>;
  saveAlertEpisode(episode: AlertEpisode): Promise<void>;
}

export class MongoMonitoringStore implements MonitoringStore {
  constructor(private readonly db: () => Db) {}

  async ensureIndexes(): Promise<void> {}

  async getNotificationSettings(ownerId: string): Promise<NotificationSettings | undefined> {
    const doc = await this.db().collection('notificationSettings').findOne({ _id: ownerId as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc as Record<string, unknown>;
    return { ...(rest as Omit<NotificationSettings, 'ownerId'>), ownerId: String(_id) };
  }

  async saveNotificationSettings(settings: NotificationSettings): Promise<void> {
    const { ownerId, ...rest } = settings;
    await this.db().collection('notificationSettings').replaceOne({ _id: ownerId as never }, rest, { upsert: true });
  }

  async getMonitoringSettings(): Promise<MonitoringSetting[]> {
    const docs = await this.db().collection('monitoringSettings').find({}).toArray();
    return docs.map((doc) => {
      const { _id, ...rest } = doc as Record<string, unknown>;
      return { ...(rest as Omit<MonitoringSetting, 'clusterId'>), clusterId: String(_id) };
    });
  }

  async saveMonitoringSetting(setting: MonitoringSetting): Promise<void> {
    const { clusterId, ...rest } = setting;
    await this.db().collection('monitoringSettings').replaceOne({ _id: clusterId as never }, rest, { upsert: true });
  }

  async getAlertRules(ownerId?: string): Promise<AlertRuleRecord[]> {
    const docs = await this.db().collection('monitoringAlertRules').find(ownerId === undefined ? {} : { ownerId }).toArray();
    return docs.map((doc) => fromDoc<AlertRuleRecord>(doc as Record<string, unknown>));
  }

  async saveAlertRule(rule: AlertRuleRecord): Promise<void> {
    await this.db().collection('monitoringAlertRules').replaceOne({ _id: rule.id as never }, toDoc(rule), { upsert: true });
  }

  async deleteAlertRule(id: string): Promise<void> {
    await this.db().collection('monitoringAlertRules').deleteOne({ _id: id as never });
  }

  async getAlertEpisodes(ownerId?: string): Promise<AlertEpisode[]> {
    const docs = await this.db().collection('monitoringAlertEpisodes').find(ownerId === undefined ? {} : { ownerId }).sort({ startedAt: -1 }).toArray();
    return docs.map((doc) => fromDoc<AlertEpisode>(doc as Record<string, unknown>));
  }

  async saveAlertEpisode(episode: AlertEpisode): Promise<void> {
    await this.db().collection('monitoringAlertEpisodes').replaceOne({ _id: episode.id as never }, toDoc(episode), { upsert: true });
  }
}
