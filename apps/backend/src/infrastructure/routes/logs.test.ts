import { describe, expect, it } from 'vitest';
import axios from 'axios';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logsRouter } from './logs.js';
import { mountRouter, TEST_USER } from '../../platform/routes/test-harness.js';
import { allowed, clusterResource, type Principal } from '../../platform/lib/permissions.js';

describe('/api/logs/pipeline', () => {
  it('shows a build\'s log only to whoever owns its project', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-logs-'));
    await fs.writeFile(path.join(dir, 'mine.log'), 'built mine');
    await fs.writeFile(path.join(dir, 'theirs.log'), 'their secret build output');
    const harness = await mountRouter({ prefix: '/api/logs', router: async (db) => logsRouter({ db, clusterService: { getById: async () => undefined }, appService: { getAll: async () => [] } }) });
    await harness.db.projects.saveProjectInfo({ id: 'p-mine', name: 'Mine', ownerId: TEST_USER.id, createdAt: 't' } as never);
    await harness.db.projects.saveProjectInfo({ id: 'p-theirs', name: 'Theirs', ownerId: 'someone-else', createdAt: 't' } as never);
    await harness.db.releases.savePipelineRun({ id: 'run-mine', projectId: 'p-mine', logFile: path.join(dir, 'mine.log'), startedAt: 't' } as never);
    await harness.db.releases.savePipelineRun({ id: 'run-theirs', projectId: 'p-theirs', logFile: path.join(dir, 'theirs.log'), startedAt: 't' } as never);

    expect((await axios.get(harness.url('/api/logs/pipeline/run-mine'))).data).toEqual({ content: 'built mine' });
    expect((await axios.get(harness.url('/api/logs/pipeline/run-theirs'))).data).toEqual({ content: 'Initializing...' });
    await harness.close();
    await fs.rm(dir, { recursive: true });
  });
});

describe('/api/logs/cluster', () => {
  it('shows the system cluster\'s provisioning log only to its operator', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-logs-'));
    const system = { id: 'provisioning-lunorica', isSystem: true, lastLogPath: path.join(dir, 'system.log') };
    await fs.writeFile(system.lastLogPath, 'k3s installed');
    const clusterService = { getById: async (id: string, principal: Principal, action: 'see-everything') => (id === system.id && allowed(principal, action, clusterResource(system)) ? system : undefined) };
    const harness = await mountRouter({ prefix: '/api/logs', router: async (db) => logsRouter({ db, clusterService, appService: { getAll: async () => [] } }) });
    expect((await axios.get(harness.url(`/api/logs/cluster/${system.id}`))).data).toEqual({ content: 'Initializing...' });
    harness.setUser({ ...TEST_USER, isAdmin: true });
    expect((await axios.get(harness.url(`/api/logs/cluster/${system.id}`))).data).toEqual({ content: 'k3s installed' });
    await harness.close();
    await fs.rm(dir, { recursive: true });
  });
});
