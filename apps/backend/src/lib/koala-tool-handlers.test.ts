import { describe, it, expect, vi } from 'vitest';
import { handleInjectSecretToPod, handleRequestSecret } from './koala-tool-handlers.js';

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
