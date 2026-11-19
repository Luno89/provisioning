import { afterAll, describe, expect, it } from 'vitest';
import { leaseMongo, type MongoLease } from '../platform/lib/mongo-lease.js';
import { testDatabaseAt } from '../platform/lib/test-database.js';
import { noticeMessage } from '../engine/lib/conversations.js';
import { movedRecordsIn } from './store.js';

const POOL = 'pool-bo';
const MACHINE = 'machine-desk';
const ELSEWHERE = 'machine-laptop';
const AT = '2026-11-18T10:00:00.000Z';

const notice = (clusterId: string) => noticeMessage({ key: `alert-${clusterId}`, kind: 'alert-firing', text: 'shop is down', refs: { clusterId, deploymentId: 'd1' }, actions: ['open-monitoring'] }, AT);

describe('a moved instance\'s records, renamed from the pool\'s cluster to the machine\'s', () => {
  const opened: MongoLease[] = [];
  afterAll(async () => {
    for (const lease of opened) await lease.release();
  });

  it('name the machine\'s cluster wherever they named the pool\'s, and keep every other cluster as it was', async () => {
    const { db, uri, dbName } = await testDatabaseAt();
    await db.infrastructure.saveDeployment({ id: 'd1', name: 'shop', clusterId: POOL, strategy: 'helm', status: 'running', ownerId: 'bo' } as never);
    await db.infrastructure.saveDeployment({ id: 'd2', name: 'blog', clusterId: ELSEWHERE, strategy: 'helm', status: 'running', ownerId: 'bo' } as never);
    await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'bo', createdAt: AT, targetClusterId: POOL } as never);
    await db.projects.saveProject({ id: 'p2', name: 'Blog', ownerId: 'bo', createdAt: AT, targetClusterId: ELSEWHERE } as never);
    await db.monitoring.saveMonitoringSetting({ clusterId: POOL, ownerId: 'bo', historyDays: 30, updatedAt: AT });
    await db.monitoring.saveMonitoringSetting({ clusterId: ELSEWHERE, ownerId: 'bo', historyDays: 7, updatedAt: AT });
    await db.monitoring.saveAlertRule({ id: 'r1', ownerId: 'bo', deploymentId: 'd1', clusterId: POOL, namespace: 'shop', appName: 'shop', spec: {} as never, summary: 'shop is down', createdAt: AT });
    await db.monitoring.saveAlertEpisode({ id: 'e1', ownerId: 'bo', clusterId: POOL, key: 'k1', name: 'down', summary: 'shop is down', about: {} as never, startedAt: AT });
    await db.infrastructure.openProvisioning({ id: 'pr1', runId: 'run-1', ownerId: 'bo', target: { kind: 'koala', clusterId: POOL }, revision: 1, reason: 'revision', state: 'up', pieces: [], startedAt: AT });
    await db.engine.saveConversation({ id: 'c1', ownerId: 'bo', title: 'Shop', createdAt: AT, updatedAt: AT, messages: [notice(ELSEWHERE), notice(POOL), { role: 'user', content: 'is it back?', at: AT }] } as never);

    const lease = await leaseMongo(uri);
    opened.push(lease);
    expect(await movedRecordsIn(lease.client.db(dbName)).retargetCluster(POOL, MACHINE)).toBe(7);

    const deployments = await db.infrastructure.getDeployments();
    expect(Object.fromEntries(deployments.map((dep) => [dep.id, dep.clusterId]))).toEqual({ d1: MACHINE, d2: ELSEWHERE });
    const projects = await db.projects.getProjects();
    expect(Object.fromEntries(projects.map((project) => [project.id, project.targetClusterId]))).toEqual({ p1: MACHINE, p2: ELSEWHERE });
    const settings = await db.monitoring.getMonitoringSettings();
    expect(Object.fromEntries(settings.map((setting) => [setting.clusterId, setting.historyDays]))).toEqual({ [MACHINE]: 30, [ELSEWHERE]: 7 });
    expect((await db.monitoring.getAlertRules('bo')).map((rule) => rule.clusterId)).toEqual([MACHINE]);
    expect((await db.monitoring.getAlertEpisodes('bo')).map((episode) => episode.clusterId)).toEqual([MACHINE]);
    expect((await db.infrastructure.getProvisioning(MACHINE)).map((record) => record.id)).toEqual(['pr1']);
    expect(await db.infrastructure.getProvisioning(POOL)).toEqual([]);
    const conversation = await db.engine.getConversation('bo', 'c1');
    expect(conversation?.messages.map((message) => message.notice?.refs.clusterId)).toEqual([ELSEWHERE, MACHINE, undefined]);
    expect(conversation?.messages.map((message) => message.content)).toEqual(['shop is down', 'shop is down', 'is it back?']);
  });

  it('renames nothing when no record names the pool\'s cluster', async () => {
    const { db, uri, dbName } = await testDatabaseAt();
    await db.infrastructure.saveDeployment({ id: 'd2', name: 'blog', clusterId: ELSEWHERE, strategy: 'helm', status: 'running', ownerId: 'bo' } as never);
    const lease = await leaseMongo(uri);
    opened.push(lease);
    expect(await movedRecordsIn(lease.client.db(dbName)).retargetCluster(POOL, MACHINE)).toBe(0);
    expect((await db.infrastructure.getDeployments()).map((dep) => dep.clusterId)).toEqual([ELSEWHERE]);
  });
});
