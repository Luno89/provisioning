import type { Router } from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { allowed, clusterResource, type ClusterMetadata, type Principal } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { AppService } from '../services/AppService.js';
import { logsRouter, type LogsRouterDeps } from './logs.js';
import { OPERATOR, PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/logs', router: () => router, user: PERSON });

const folder = mkdtempSync(join(tmpdir(), 'route-logs-'));
const logAt = (name: string, content: string): string => {
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
};

const nobodys = (): LogsRouterDeps['clusterService'] => ({ getById: async () => undefined });

describe('/api/logs/pipeline', () => {
  it('shows a build\'s log only to whoever owns its project', async () => {
    const db = memoryDatabase();
    await db.projects.saveProjectInfo({ id: 'p-mine', name: 'Mine', ownerId: PERSON.id, createdAt: 't' } as never);
    await db.projects.saveProjectInfo({ id: 'p-theirs', name: 'Theirs', ownerId: 'someone-else', createdAt: 't' } as never);
    await db.releases.savePipelineRunInfo({ id: 'run-mine', projectId: 'p-mine', logFile: logAt('mine.log', 'built mine'), startedAt: 't' } as never);
    await db.releases.savePipelineRunInfo({ id: 'run-theirs', projectId: 'p-theirs', logFile: logAt('theirs.log', 'their secret build output'), startedAt: 't' } as never);
    const router = logsRouter({ db, clusterService: nobodys(), appService: mock<AppService>() });
    expect((await (await on(router)).get('/api/logs/pipeline/run-mine')).data).toEqual({ content: 'built mine' });
    expect((await (await on(router)).get('/api/logs/pipeline/run-theirs')).data).toEqual({ content: 'Initializing...' });
    expect((await (await on(router)).get('/api/logs/pipeline/no-such-run')).data).toEqual({ content: 'Initializing...' });
  });
});

describe('/api/logs/cluster', () => {
  it('shows the system cluster\'s provisioning log only to its operator', async () => {
    const system = { id: 'provisioning-lunorica', isSystem: true, lastLogPath: logAt('system.log', 'k3s installed') };
    const clusterService: LogsRouterDeps['clusterService'] = { getById: async (id: string, principal: Principal, action: 'see-everything') => (id === system.id && allowed(principal, action, clusterResource(system)) ? system : undefined) };
    const router = logsRouter({ db: memoryDatabase(), clusterService, appService: mock<AppService>() });
    expect((await (await on(router)).get(`/api/logs/cluster/${system.id}`)).data).toEqual({ content: 'Initializing...' });
    expect((await (await on(router)).get(`/api/logs/cluster/${system.id}`, { user: OPERATOR })).data).toEqual({ content: 'k3s installed' });
  });
});

describe('/api/logs/app', () => {
  it('shows the log of an app of the person\'s, waiting while its file is not there yet', async () => {
    const appService = mock<AppService>();
    appService.getAll.calledWith(PERSON.id).mockResolvedValue([
      { id: 'a1', lastLogPath: logAt('a1.log', 'deployed') },
      { id: 'a2', lastLogPath: join(folder, 'not-yet.log') },
    ] as unknown as Awaited<ReturnType<AppService['getAll']>>);
    const router = logsRouter({ db: memoryDatabase(), clusterService: nobodys(), appService });
    expect((await (await on(router)).get('/api/logs/app/a1')).data).toEqual({ content: 'deployed' });
    expect((await (await on(router)).get('/api/logs/app/a2')).data).toEqual({ content: 'Waiting for logs...' });
    expect((await (await on(router)).get('/api/logs/app/a3')).data).toEqual({ content: 'Initializing...' });
  });
});

describe('/api/logs/cluster of the person\'s own', () => {
  it('asks for the cluster as someone who can see everything on it', async () => {
    const cluster: Pick<ClusterMetadata, 'lastLogPath'> = { lastLogPath: logAt('own.log', 'mine') };
    const getById = mock<LogsRouterDeps['clusterService']>();
    getById.getById.calledWith('c1', matches<Principal>((who) => who.id === PERSON.id), 'see-everything').mockResolvedValue(cluster);
    const router = logsRouter({ db: memoryDatabase(), clusterService: getById, appService: mock<AppService>() });
    expect((await (await on(router)).get('/api/logs/cluster/c1')).data).toEqual({ content: 'mine' });
  });
});
