import { describe, it, expect, vi } from 'vitest';
import { handleInjectSecretToPod, handleRequestSecret, handleDeployApp, handleListClusters } from './koala-tool-handlers.js';

describe('handleDeployApp', () => {
  const catalogue = [{ id: 'jellyfin', spec: { id: 'jellyfin', image: 'jellyfin/jellyfin', ports: [] } }];
  const cluster = { id: 'cl1', name: 'my-cluster', ownerId: 'u1', provider: 'aws', status: 'healthy' };
  const cluster2 = { id: 'cl2', name: 'other-cluster', ownerId: 'u1', provider: 'gcp', status: 'healthy' };

  const baseCtx = () => ({
    db: {
      getAppSpecs: vi.fn().mockResolvedValue(catalogue),
      getClusters: vi.fn().mockResolvedValue([cluster]),
    },
    temporalBridge: {
      deployApp: vi.fn().mockResolvedValue({ id: 'wf1', resourceId: 'dep1', event: 'app-deploy' }),
    },
    clusterService: {
      getById: vi.fn().mockImplementation(async (id: string, userId: string) =>
        ([cluster, cluster2].find((c) => c.id === id) && userId === cluster.ownerId) ? [cluster, cluster2].find((c) => c.id === id) : undefined),
      getAll: vi.fn().mockResolvedValue([cluster]),
    },
    userId: 'u1',
  } as any);

  it('deploys a known catalogue app to a cluster the user owns', async () => {
    const ctx = baseCtx();
    const out = await handleDeployApp(ctx, { appType: 'jellyfin', clusterId: 'cl1', name: 'my-jellyfin' });

    expect(ctx.temporalBridge.deployApp).toHaveBeenCalledWith(
      { appType: 'jellyfin', clusterId: 'cl1', name: 'my-jellyfin', strategy: 'helm' }, 'u1',
    );
    const body = JSON.parse(out.content);
    expect(body.status).toBe('deploying');
    expect(body.workflowId).toBe('wf1');
  });

  it('refuses an appType not in the catalogue', async () => {
    const ctx = baseCtx();
    const out = await handleDeployApp(ctx, { appType: 'wordpress', clusterId: 'cl1', name: 'x' });

    expect(ctx.temporalBridge.deployApp).not.toHaveBeenCalled();
    const body = JSON.parse(out.content);
    expect(body.error).toMatch(/not in the catalogue/);
    expect(body.available).toEqual(['jellyfin']);
  });

  it('refuses a cluster the user does not own', async () => {
    const ctx = baseCtx();
    ctx.userId = 'someone-else';
    const out = await handleDeployApp(ctx, { appType: 'jellyfin', clusterId: 'cl1', name: 'x' });

    expect(ctx.temporalBridge.deployApp).not.toHaveBeenCalled();
    expect(JSON.parse(out.content).error).toMatch(/No cluster/);
  });

  it('requires appType and name', async () => {
    const ctx = baseCtx();
    const out = await handleDeployApp(ctx, { appType: 'jellyfin' });
    expect(JSON.parse(out.content).error).toMatch(/required/);
  });

  it('defaults clusterId to the user\'s only cluster when omitted', async () => {
    const ctx = baseCtx();
    const out = await handleDeployApp(ctx, { appType: 'jellyfin', name: 'my-jellyfin' });

    expect(ctx.temporalBridge.deployApp).toHaveBeenCalledWith(
      { appType: 'jellyfin', clusterId: 'cl1', name: 'my-jellyfin', strategy: 'helm' }, 'u1',
    );
    expect(JSON.parse(out.content).status).toBe('deploying');
  });

  it('reports the list and asks rather than deploying when clusterId is omitted and there are several', async () => {
    const ctx = baseCtx();
    ctx.clusterService.getAll.mockResolvedValue([cluster, cluster2]);
    const out = await handleDeployApp(ctx, { appType: 'jellyfin', name: 'my-jellyfin' });

    expect(ctx.temporalBridge.deployApp).not.toHaveBeenCalled();
    const body = JSON.parse(out.content);
    expect(body.error).toMatch(/more than one cluster/i);
    expect(body.clusters).toEqual([
      { id: 'cl1', name: 'my-cluster', provider: 'aws', status: 'healthy' },
      { id: 'cl2', name: 'other-cluster', provider: 'gcp', status: 'healthy' },
    ]);
  });

  it('errors when clusterId is omitted and there are no clusters', async () => {
    const ctx = baseCtx();
    ctx.clusterService.getAll.mockResolvedValue([]);
    const out = await handleDeployApp(ctx, { appType: 'jellyfin', name: 'my-jellyfin' });

    expect(ctx.temporalBridge.deployApp).not.toHaveBeenCalled();
    expect(JSON.parse(out.content).error).toMatch(/no clusters/i);
  });
});

describe('handleListClusters', () => {
  const cluster = { id: 'cl1', name: 'my-cluster', ownerId: 'u1', provider: 'aws', status: 'healthy' };
  const system = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true };

  it('lists the clusters this user can see', async () => {
    const ctx = {
      userId: 'u1',
      clusterService: { getAll: vi.fn().mockResolvedValue([system, cluster]) },
    } as any;

    const out = await handleListClusters(ctx, {});
    expect(ctx.clusterService.getAll).toHaveBeenCalledWith('u1');
    expect(JSON.parse(out.content).clusters).toEqual([
      { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true },
      { id: 'cl1', name: 'my-cluster', provider: 'aws', status: 'healthy' },
    ]);
  });

  it('errors when cluster access is not available', async () => {
    const out = await handleListClusters({ userId: 'u1' } as any, {});
    expect(JSON.parse(out.content).error).toMatch(/not available/i);
  });
});

/**
 * Regression for a real bug: this handler used to pass the raw, unsanitised project name as both
 * the k8s namespace and the Deployment name. "Gitea MCP Server" is not a legal namespace, and the
 * gitapp construct always names its Deployment the literal "gitapp" — never the project name.
 */
describe('handleInjectSecretToPod', () => {
  it('sanitises the project name into a namespace and targets the real "gitapp" deployment', async () => {
    const injectSecretToPod = vi.fn().mockResolvedValue({ success: true, podRestarted: true });
    const ctx: any = {
      db: {
        getProjects: vi.fn().mockResolvedValue([
          { id: 'proj-1', name: 'Gitea MCP Server' },
        ]),
      },
      infisicalService: { injectSecretToPod },
      userId: 'u1',
      conversationId: 'c1',
      servers: [],
      webSearch: async () => ({ results: [] }),
      fetchWebPage: async () => '',
    };

    await handleInjectSecretToPod(ctx, { projectId: 'proj-1', key: 'GITEA_TOKEN' });

    expect(injectSecretToPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'gitea-mcp-server', deploymentName: 'gitapp' }),
    );
  });
});

describe('handleRequestSecret', () => {
  const project = { id: 'proj-1', name: 'Gitea MCP Server', ownerId: 'u1' };

  const baseCtx = () => ({
    db: {
      getProjects: vi.fn().mockResolvedValue([project]),
      getConversations: vi.fn().mockResolvedValue([{ id: 'c1', proposedSecretRequests: [] }]),
      saveConversation: vi.fn(),
      saveProject: vi.fn(),
    },
    projects: { mintReadToken: vi.fn().mockResolvedValue({ token: 'tok_123', tokenName: 'koala-mcp-abcd', username: 'koala-u1' }) },
    infisicalService: {
      getSecret: vi.fn().mockResolvedValue(null),
      setSecret: vi.fn().mockResolvedValue({ success: true, secretReference: 'secret://proj-1/GITEA_TOKEN' }),
      injectSecretToPod: vi.fn().mockResolvedValue({ success: true, podRestarted: true }),
    },
    userId: 'u1',
    conversationId: 'c1',
  } as any);

  it('auto-mints and injects a GITEA_TOKEN for a project the user owns, instead of asking them', async () => {
    const ctx = baseCtx();
    const out = await handleRequestSecret(ctx, {
      key: 'GITEA_TOKEN', description: 'needs gitea access', projectId: 'proj-1',
    });

    expect(ctx.projects.mintReadToken).toHaveBeenCalledWith('u1');
    expect(ctx.infisicalService.setSecret).toHaveBeenCalledWith('proj-1', 'GITEA_TOKEN', 'tok_123', expect.any(String));
    expect(ctx.infisicalService.injectSecretToPod).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', namespace: 'gitea-mcp-server', deploymentName: 'gitapp', key: 'GITEA_TOKEN', value: 'tok_123' }),
    );
    expect(ctx.db.saveProject).toHaveBeenCalledWith(
      expect.objectContaining({ requiredSecrets: [{ key: 'GITEA_TOKEN', source: 'gitea-read-token' }] }),
    );
    expect(ctx.db.saveConversation).not.toHaveBeenCalled();
    expect(JSON.parse(out.content).status).toBe('auto-provisioned');
  });

  it('matches a differently-worded Gitea key, not just the literal GITEA_TOKEN', async () => {
    const ctx = baseCtx();
    const out = await handleRequestSecret(ctx, {
      key: 'GIT_API_KEY', description: 'needs gitea access', projectId: 'proj-1',
    });

    expect(ctx.projects.mintReadToken).toHaveBeenCalled();
    expect(JSON.parse(out.content).status).toBe('auto-provisioned');
  });

  it('does not treat GITHUB_TOKEN as a Gitea key', async () => {
    const ctx = baseCtx();
    const out = await handleRequestSecret(ctx, {
      key: 'GITHUB_TOKEN', description: 'needs github access', projectId: 'proj-1',
    });

    expect(ctx.projects.mintReadToken).not.toHaveBeenCalled();
    expect(JSON.parse(out.content).status).toBe('requested');
  });

  it('reuses an already-vaulted value instead of minting a new token every time', async () => {
    const ctx = baseCtx();
    ctx.infisicalService.getSecret.mockResolvedValue('tok_already_vaulted');
    const out = await handleRequestSecret(ctx, {
      key: 'GITEA_TOKEN', description: 'needs gitea access', projectId: 'proj-1',
    });

    expect(ctx.projects.mintReadToken).not.toHaveBeenCalled();
    expect(ctx.infisicalService.setSecret).not.toHaveBeenCalled();
    expect(ctx.infisicalService.injectSecretToPod).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'tok_already_vaulted' }),
    );
    expect(JSON.parse(out.content).reused).toBe(true);
  });

  it('skips the heuristic once a project has a recorded mapping, going straight to the declared source', async () => {
    const ctx = baseCtx();
    ctx.db.getProjects.mockResolvedValue([{ ...project, requiredSecrets: [{ key: 'MY_WEIRD_NAME', source: 'gitea-read-token' }] }]);
    const out = await handleRequestSecret(ctx, {
      key: 'MY_WEIRD_NAME', description: 'needs gitea access', projectId: 'proj-1',
    });

    expect(ctx.projects.mintReadToken).toHaveBeenCalled();
    expect(ctx.db.saveProject).not.toHaveBeenCalled();
    expect(JSON.parse(out.content).status).toBe('auto-provisioned');
  });

  it('falls back to asking the user for any other key', async () => {
    const ctx = baseCtx();
    const out = await handleRequestSecret(ctx, {
      key: 'STRIPE_KEY', description: 'needs stripe access', projectId: 'proj-1',
    });

    expect(ctx.projects.mintReadToken).not.toHaveBeenCalled();
    expect(ctx.db.saveConversation).toHaveBeenCalled();
    expect(JSON.parse(out.content).status).toBe('requested');
  });

  it('falls back to asking the user when the project belongs to someone else', async () => {
    const ctx = baseCtx();
    ctx.userId = 'someone-else';
    const out = await handleRequestSecret(ctx, {
      key: 'GITEA_TOKEN', description: 'needs gitea access', projectId: 'proj-1',
    });

    expect(ctx.projects.mintReadToken).not.toHaveBeenCalled();
    expect(JSON.parse(out.content).status).toBe('requested');
  });
});
