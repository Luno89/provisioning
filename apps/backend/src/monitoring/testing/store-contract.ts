import { describe, expect, it } from 'vitest';
import type { NotificationSettings } from '../../platform/index.js';
import type { AlertRuleRecord } from '../lib/monitoring-alerts.js';
import type { AlertEpisode, MonitoringSetting } from '../lib/monitoring-records.js';
import type { PushSubscriptionRecord } from '../lib/web-push.js';
import type { MonitoringStore } from '../store.js';

const setting = (clusterId: string, extra: Partial<MonitoringSetting> = {}): MonitoringSetting => ({
  clusterId, ownerId: 'u1', historyDays: 10, updatedAt: '2026-10-27T00:00:00.000Z', ...extra,
});

const rule = (id: string, extra: Partial<AlertRuleRecord> = {}): AlertRuleRecord => ({
  id, ownerId: 'u1', deploymentId: 'd1', clusterId: 'c1', namespace: 'shop-abc123', appName: 'shop',
  spec: { kind: 'down', threshold: 0, forMinutes: 5 }, summary: 'shop stops answering', createdAt: '2026-10-27T00:00:00.000Z', ...extra,
});

const episode = (id: string, extra: Partial<AlertEpisode> = {}): AlertEpisode => ({
  id, ownerId: 'u1', clusterId: 'c1', key: `key-${id}`, name: 'Down', summary: 'shop is down',
  about: { kind: 'app', deploymentId: 'd1' }, startedAt: '2026-10-27T00:00:00.000Z', ...extra,
});

const subscription = (id: string, extra: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord => ({
  id, ownerId: 'u1', endpoint: `https://push.example/${id}`, keys: { p256dh: `p-${id}`, auth: `a-${id}` }, label: 'Phone', createdAt: '2026-10-27T00:00:00.000Z', ...extra,
});

export function monitoringStoreContract(make: () => Promise<MonitoringStore>): void {
  describe('how long a cluster keeps its history', () => {
    it('keeps a cluster\'s setting, replaces it whole when saved again, and lists every cluster\'s', async () => {
      const store = await make();
      expect(await store.getMonitoringSettings()).toEqual([]);
      await store.saveMonitoringSetting(setting('c1', { appliedAt: '2026-10-27T01:00:00.000Z', problem: 'no room' }));
      await store.saveMonitoringSetting(setting('c2', { ownerId: 'u2', historyDays: 30 }));
      expect(await store.getMonitoringSettings()).toHaveLength(2);
      await store.saveMonitoringSetting(setting('c1', { historyDays: 20 }));
      const stored = await store.getMonitoringSettings();
      expect(stored).toHaveLength(2);
      expect(stored.find((entry) => entry.clusterId === 'c1')).toEqual(setting('c1', { historyDays: 20 }));
      expect(stored.find((entry) => entry.clusterId === 'c2')).toEqual(setting('c2', { ownerId: 'u2', historyDays: 30 }));
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveMonitoringSetting(setting('c1'));
      (await store.getMonitoringSettings())[0]!.historyDays = 99;
      expect((await store.getMonitoringSettings())[0]?.historyDays).toBe(10);
    });
  });

  describe('how a person hears about alerts', () => {
    it('keeps a person\'s settings, replaces them whole when saved again, and has none for someone else', async () => {
      const store = await make();
      expect(await store.getNotificationSettings('u1')).toBeUndefined();
      await store.saveNotificationSettings({ ownerId: 'u1', email: 'down', updatedAt: '2026-10-27T00:00:00.000Z' });
      await store.saveNotificationSettings({ ownerId: 'u2', email: 'off', updatedAt: '2026-10-27T00:00:00.000Z' });
      expect(await store.getNotificationSettings('u1')).toEqual({ ownerId: 'u1', email: 'down', updatedAt: '2026-10-27T00:00:00.000Z' });
      const changed: NotificationSettings = { ownerId: 'u1', email: 'all', updatedAt: '2026-10-28T00:00:00.000Z' };
      await store.saveNotificationSettings(changed);
      expect(await store.getNotificationSettings('u1')).toEqual(changed);
      expect(await store.getNotificationSettings('u2')).toMatchObject({ email: 'off' });
    });
  });

  describe('alert rules', () => {
    it('keeps a rule as saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveAlertRule(rule('r1', { conversationId: 'chat-1' }));
      expect(await store.getAlertRules()).toEqual([rule('r1', { conversationId: 'chat-1' })]);
      await store.saveAlertRule(rule('r1', { summary: 'changed' }));
      expect(await store.getAlertRules()).toEqual([rule('r1', { summary: 'changed' })]);
      await store.deleteAlertRule('r1');
      expect(await store.getAlertRules()).toEqual([]);
      await store.deleteAlertRule('never');
    });

    it('lists every rule, or only one person\'s when asked', async () => {
      const store = await make();
      await store.saveAlertRule(rule('r1'));
      await store.saveAlertRule(rule('r2', { ownerId: 'u2' }));
      await store.saveAlertRule(rule('r3'));
      expect((await store.getAlertRules()).map((entry) => entry.id).sort()).toEqual(['r1', 'r2', 'r3']);
      expect((await store.getAlertRules('u1')).map((entry) => entry.id).sort()).toEqual(['r1', 'r3']);
      expect((await store.getAlertRules('u2')).map((entry) => entry.id)).toEqual(['r2']);
      expect(await store.getAlertRules('nobody')).toEqual([]);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveAlertRule(rule('r1'));
      (await store.getAlertRules())[0]!.summary = 'changed';
      expect((await store.getAlertRules())[0]?.summary).toBe('shop stops answering');
    });
  });

  describe('alert episodes', () => {
    it('keeps an episode as saved and replaces it whole when it resolves', async () => {
      const store = await make();
      await store.saveAlertEpisode(episode('e1', { ruleId: 'r1' }));
      expect(await store.getAlertEpisodes()).toEqual([episode('e1', { ruleId: 'r1' })]);
      await store.saveAlertEpisode(episode('e1', { ruleId: 'r1', resolvedAt: '2026-10-27T02:00:00.000Z' }));
      expect(await store.getAlertEpisodes()).toEqual([episode('e1', { ruleId: 'r1', resolvedAt: '2026-10-27T02:00:00.000Z' })]);
    });

    it('lists the newest first, every person\'s or only one\'s when asked', async () => {
      const store = await make();
      await store.saveAlertEpisode(episode('old', { startedAt: '2026-10-25T00:00:00.000Z' }));
      await store.saveAlertEpisode(episode('new', { startedAt: '2026-10-29T00:00:00.000Z' }));
      await store.saveAlertEpisode(episode('mid', { startedAt: '2026-10-27T00:00:00.000Z', ownerId: 'u2' }));
      expect((await store.getAlertEpisodes()).map((entry) => entry.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.getAlertEpisodes('u1')).map((entry) => entry.id)).toEqual(['new', 'old']);
      expect((await store.getAlertEpisodes('u2')).map((entry) => entry.id)).toEqual(['mid']);
      expect(await store.getAlertEpisodes('nobody')).toEqual([]);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveAlertEpisode(episode('e1'));
      (await store.getAlertEpisodes())[0]!.name = 'changed';
      expect((await store.getAlertEpisodes())[0]?.name).toBe('Down');
    });
  });

  describe('devices that are pushed to', () => {
    it('lists a person\'s devices oldest first, and only theirs', async () => {
      const store = await make();
      await store.savePushSubscription(subscription('late', { createdAt: '2026-10-29T00:00:00.000Z' }));
      await store.savePushSubscription(subscription('early', { createdAt: '2026-10-25T00:00:00.000Z' }));
      await store.savePushSubscription(subscription('stranger', { ownerId: 'u2' }));
      expect((await store.getPushSubscriptions('u1')).map((entry) => entry.id)).toEqual(['early', 'late']);
      expect((await store.getPushSubscriptions('u2')).map((entry) => entry.id)).toEqual(['stranger']);
      expect(await store.getPushSubscriptions('nobody')).toEqual([]);
      expect((await store.getPushSubscriptions('u1'))[0]).toEqual(subscription('early', { createdAt: '2026-10-25T00:00:00.000Z' }));
    });

    it('keeps one record for a device saved again, with its first id and date and its new keys and label', async () => {
      const store = await make();
      await store.savePushSubscription(subscription('first'));
      await store.savePushSubscription({ ...subscription('second'), endpoint: 'https://push.example/first', keys: { p256dh: 'new-p', auth: 'new-a' }, label: 'Tablet', createdAt: '2026-10-30T00:00:00.000Z' });
      const stored = await store.getPushSubscriptions('u1');
      expect(stored).toEqual([{ ...subscription('first'), keys: { p256dh: 'new-p', auth: 'new-a' }, label: 'Tablet' }]);
    });

    it('lets two people each keep a device at the same address', async () => {
      const store = await make();
      await store.savePushSubscription(subscription('a'));
      await store.savePushSubscription({ ...subscription('b'), ownerId: 'u2', endpoint: 'https://push.example/a' });
      expect(await store.getPushSubscriptions('u1')).toHaveLength(1);
      expect(await store.getPushSubscriptions('u2')).toHaveLength(1);
    });

    it('refuses a new device under an id already taken, and keeps the first', async () => {
      const store = await make();
      await store.savePushSubscription(subscription('a'));
      await expect(store.savePushSubscription({ ...subscription('a'), endpoint: 'https://push.example/elsewhere' })).rejects.toThrow();
      expect(await store.getPushSubscriptions('u1')).toEqual([subscription('a')]);
    });

    it('removes a device only for the person it belongs to, and says whether it did', async () => {
      const store = await make();
      await store.savePushSubscription(subscription('a'));
      expect(await store.deletePushSubscription('u2', 'a')).toBe(false);
      expect(await store.getPushSubscriptions('u1')).toHaveLength(1);
      expect(await store.deletePushSubscription('u1', 'never')).toBe(false);
      expect(await store.deletePushSubscription('u1', 'a')).toBe(true);
      expect(await store.getPushSubscriptions('u1')).toEqual([]);
      expect(await store.deletePushSubscription('u1', 'a')).toBe(false);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.savePushSubscription(subscription('a'));
      const [read] = await store.getPushSubscriptions('u1');
      read!.label = 'changed';
      read!.keys.auth = 'changed';
      expect(await store.getPushSubscriptions('u1')).toEqual([subscription('a')]);
    });
  });
}
