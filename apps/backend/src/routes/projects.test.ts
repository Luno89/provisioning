import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { projectsRouter } from './projects.js';
import { mountRouter, type Harness, TEST_USER } from './test-harness.js';
import { ownsProject } from '../lib/ownership.js';
import type { Database } from '../lib/db-interface.js';

const project = {
  id: 'proj-1',
  name: 'demo',
  giteaOwner: 'acme',
  giteaRepo: 'demo',
  ownerId: TEST_USER.id,
  appType: 'gitapp',
  createdAt: '2026-01-01T00:00:00Z',
};

function giteaServiceStub(commit: { message: string } | null) {
  return {
    getCommit: async (_owner: string, _repo: string, _sha: string) => commit,
  };
}

async function mountWithGitea(gitea: { getCommit: (...args: any[]) => Promise<any> }): Promise<Harness> {
  return mountRouter({
    prefix: '/api/projects',
    router: (db: Database) => projectsRouter({
      db,
      giteaService: gitea,
      getOwnedProject: async (id: string, user: any) => {
        const p = (await db.getProjects()).find((x: any) => x.id === id);
        return p && ownsProject(p, user) ? p : undefined;
      },
    }),
  });
}

async function mountForCreate(): Promise<Harness> {
  return mountRouter({
    prefix: '/api/projects',
    router: (db: Database) => projectsRouter({
      db,
      giteaService: {
        adminUsername: 'koala-bot',
        getRepo: async () => ({}),
        createWebhook: async () => undefined,
      },
      infraService: {
        runKubectl: async () => '10.0.0.5',
      },
      getOwnedProject: async (id: string, user: any) => {
        const p = (await db.getProjects()).find((x: any) => x.id === id);
        return p && ownsProject(p, user) ? p : undefined;
      },
      jwtSecret: 'test-secret',
    }),
  });
}

describe('GET /:id/runs commit-message enrichment', () => {
  it('fetches the commit message from Gitea and persists it for next time', async () => {
    const harness = await mountWithGitea(giteaServiceStub({ message: 'Fix the thing\n\nlonger body' }));
    await harness.db.saveProjectInfo(project);
    await harness.db.savePipelineRunInfo({
      id: 'run-1', projectId: project.id, commitSha: 'abc123', ref: 'main',
      status: 'succeeded', startedAt: '2026-01-01T00:00:00Z',
    });

    const res = await axios.get(harness.url(`/api/projects/${project.id}/runs`));
    expect(res.data).toHaveLength(1);
    expect(res.data[0].commitMessage).toBe('Fix the thing\n\nlonger body');

    const persisted = (await harness.db.getPipelineRuns()).find((r: any) => r.id === 'run-1');
    expect(persisted?.commitMessage).toBe('Fix the thing\n\nlonger body');

    await harness.close();
  });

  it('does not re-fetch a commit message the run already has', async () => {
    let calls = 0;
    const gitea = {
      getCommit: async () => { calls += 1; return { message: 'should not be used' }; },
    };
    const harness = await mountWithGitea(gitea);
    await harness.db.saveProjectInfo(project);
    await harness.db.savePipelineRunInfo({
      id: 'run-1', projectId: project.id, commitSha: 'abc123', ref: 'main',
      status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', commitMessage: 'Already known',
    });

    const res = await axios.get(harness.url(`/api/projects/${project.id}/runs`));
    expect(res.data[0].commitMessage).toBe('Already known');
    expect(calls).toBe(0);

    await harness.close();
  });

  it('keeps the run in the list even if Gitea fails to answer', async () => {
    const gitea = { getCommit: async () => { throw new Error('gitea unreachable'); } };
    const harness = await mountWithGitea(gitea);
    await harness.db.saveProjectInfo(project);
    await harness.db.savePipelineRunInfo({
      id: 'run-1', projectId: project.id, commitSha: 'abc123', ref: 'main',
      status: 'succeeded', startedAt: '2026-01-01T00:00:00Z',
    });

    const res = await axios.get(harness.url(`/api/projects/${project.id}/runs`));
    expect(res.data).toHaveLength(1);
    expect(res.data[0].commitMessage).toBeUndefined();

    await harness.close();
  });
});

describe('POST / — execution target', () => {
  it('persists executionTarget when the device belongs to the requesting user', async () => {
    const harness = await mountForCreate();
    await harness.db.saveLocalAgentDevice({
      id: 'dev-1', ownerId: TEST_USER.id, name: 'My Laptop', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await axios.post(harness.url('/api/projects'), {
      name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1',
    });

    expect(res.status).toBe(201);
    expect(res.data.executionTarget).toEqual({ kind: 'local-device', deviceId: 'dev-1' });

    await harness.close();
  });

  it('refuses a device that does not belong to the requesting user', async () => {
    const harness = await mountForCreate();
    await harness.db.saveLocalAgentDevice({
      id: 'dev-1', ownerId: 'someone-else', name: 'Not mine', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });

    await expect(axios.post(harness.url('/api/projects'), {
      name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1',
    })).rejects.toMatchObject({ response: { status: 400 } });

    expect(await harness.db.getProjects()).toHaveLength(0);

    await harness.close();
  });

  it('leaves executionTarget unset when no device is chosen — the K8s sandbox stays the default', async () => {
    const harness = await mountForCreate();

    const res = await axios.post(harness.url('/api/projects'), { name: 'demo', giteaRepo: 'demo' });

    expect(res.status).toBe(201);
    expect(res.data.executionTarget).toBeUndefined();

    await harness.close();
  });

  it('accepts and persists valid egress hints alongside a local device', async () => {
    const harness = await mountForCreate();
    await harness.db.saveLocalAgentDevice({
      id: 'dev-1', ownerId: TEST_USER.id, name: 'My Laptop', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });

    const res = await axios.post(harness.url('/api/projects'), {
      name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1',
      executionTargetEgress: [{ host: 'registry.npmjs.org', ports: [443] }],
    });

    expect(res.status).toBe(201);
    expect(res.data.executionTarget).toEqual({
      kind: 'local-device', deviceId: 'dev-1', egress: [{ host: 'registry.npmjs.org', ports: [443] }],
    });

    await harness.close();
  });

  it('refuses an egress rule that is not a valid hostname', async () => {
    const harness = await mountForCreate();
    await harness.db.saveLocalAgentDevice({
      id: 'dev-1', ownerId: TEST_USER.id, name: 'My Laptop', rootDir: '/x',
      tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z',
    });

    await expect(axios.post(harness.url('/api/projects'), {
      name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1',
      executionTargetEgress: [{ host: 'not a host' }],
    })).rejects.toMatchObject({ response: { status: 400 } });

    expect(await harness.db.getProjects()).toHaveLength(0);

    await harness.close();
  });

  it('ignores egress hints entirely when no local device is chosen', async () => {
    const harness = await mountForCreate();

    const res = await axios.post(harness.url('/api/projects'), {
      name: 'demo', giteaRepo: 'demo', executionTargetEgress: [{ host: 'registry.npmjs.org' }],
    });

    expect(res.status).toBe(201);
    expect(res.data.executionTarget).toBeUndefined();

    await harness.close();
  });
});
