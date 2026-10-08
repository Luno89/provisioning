import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDefinition } from '@koala/agent-engine';
import { createConversationWorkspaces, reachableAgents } from './conversation-workspaces.js';
import { NothingToShareError, type EnvironmentResolver } from './environments.js';
import type { KubeRunner } from './kube.js';
import type { WorkspaceDocuments } from './workspace-documents.js';

const AGENTS: Record<string, string[]> = { koala: ['planner', 'research'], planner: ['research', 'koala'], research: [] };
const registry = { agent: async (_ownerId: string, slug: string) => (AGENTS[slug] ? ({ slug, agents: AGENTS[slug] } as unknown as AgentDefinition) : undefined) };

const SHARED = { kind: 'sandbox' as const, id: 'engine-conversation-c1', capabilities: { lifecycle: 'persistent' }, workspace: { runId: 'conversation-c1', persistent: true } };

let namespaceExists: boolean;
let podRunning: boolean;
let calls: string[][];
let saves: string[];
let saveFails: boolean;
let execs: string[];

const kube: KubeRunner = async (args) => {
  calls.push(args);
  if (args[0] === 'get' && args[1] === 'namespace') return { stdout: '', stderr: '', exitCode: namespaceExists ? 0 : 1 };
  if (args[0] === 'get' && args[1] === 'pod') return { stdout: podRunning ? 'Running' : '', stderr: '', exitCode: podRunning ? 0 : 1 };
  return { stdout: '', stderr: '', exitCode: 0 };
};

const documents: WorkspaceDocuments = {
  save: async (request) => {
    if (saveFails) throw new Error('Pushing to koala-u1/research-c1 failed: Gitea is down');
    saves.push(`${request.workspaceRunId} ${request.path} -> ${request.repo} (${request.commitAs})`);
    return { saved: true, owner: 'koala-u1', repo: request.repo, commit: 'abc' };
  },
  restore: async () => ({ restored: true }),
  bring: async () => ({ brought: [] }),
  catchUp: async () => undefined,
  merge: async () => 'merged',
};

const resolver = (describeShared: EnvironmentResolver['describeShared']) => ({
  describeShared,
  forRun: vi.fn(async () => ({ exec: async ({ command }: { command: string }) => { execs.push(command); podRunning = true; return { exitCode: 0, stdout: '', stderr: '' }; } })),
}) as unknown as EnvironmentResolver;

const deleted = () => calls.filter((args) => args[0] === 'delete').map((args) => args.slice(0, 2).join(' '));

beforeEach(() => {
  namespaceExists = true;
  podRunning = true;
  calls = [];
  saves = [];
  saveFails = false;
  execs = [];
});

describe('a conversation\'s workspace', () => {
  it('covers its agent and everyone it can hand work to, however far down', async () => {
    expect(await reachableAgents(registry, 'u1', 'koala')).toEqual(['koala', 'planner', 'research']);
  });

  it('is described once for all of them, marked as the conversation\'s, without starting anything', async () => {
    const describeShared = vi.fn(async () => SHARED as never);
    const workspaces = createConversationWorkspaces({ resolver: resolver(describeShared), registry, kube, documents });

    const shared = await workspaces.describe({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' });

    expect(describeShared).toHaveBeenCalledWith({
      ticket: { runId: 'conversation-c1', depth: 0, ownerId: 'u1', agentSlug: 'koala', trigger: 'user' },
      agents: ['koala', 'planner', 'research'],
    });
    expect(shared?.workspace).toEqual({ runId: 'conversation-c1', persistent: true, sharedBy: 'conversation' });
    expect(calls).toEqual([]);
  });

  it('is not there when none of the agents works in a sandbox, and fails loudly for anything else', async () => {
    const none = createConversationWorkspaces({ resolver: resolver(async () => { throw new NothingToShareError(['koala']); }), registry, kube, documents });
    expect(await none.describe({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' })).toBeUndefined();

    const broken = createConversationWorkspaces({ resolver: resolver(async () => { throw new Error('image build failed'); }), registry, kube, documents });
    await expect(broken.describe({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' })).rejects.toThrow('image build failed');
  });

  it('is saved to the conversation\'s repository and then deleted when the conversation concludes', async () => {
    const workspaces = createConversationWorkspaces({ resolver: resolver(async () => SHARED as never), registry, kube, documents });

    expect(await workspaces.conclude({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' })).toMatchObject({ saved: true, repo: 'research-c1' });
    expect(saves).toEqual(['conversation-c1 /work -> research-c1 (conversation c1)']);
    expect(deleted()).toEqual(['delete namespace']);
  });

  it('is started again to be saved when its pod had stopped, so nothing it held is lost', async () => {
    podRunning = false;
    const workspaces = createConversationWorkspaces({ resolver: resolver(async () => SHARED as never), registry, kube, documents });

    await workspaces.conclude({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' });

    expect(execs).toEqual(['true']);
    expect(saves).toHaveLength(1);
    expect(deleted()).toEqual(['delete namespace']);
  });

  it('is kept when it could not be saved, and deleted when there was simply nothing in it', async () => {
    const reporting = (result: Awaited<ReturnType<WorkspaceDocuments['save']>>): WorkspaceDocuments => ({ ...documents, save: async () => result });

    const stopped = createConversationWorkspaces({ resolver: resolver(async () => SHARED as never), registry, kube, documents: reporting({ saved: false, why: 'the workspace is not running' }) });
    await expect(stopped.conclude({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' })).rejects.toThrow('could not be saved: the workspace is not running');
    expect(deleted()).toEqual([]);

    const empty = createConversationWorkspaces({ resolver: resolver(async () => SHARED as never), registry, kube, documents: reporting({ saved: false, empty: true, why: '/work has nothing committed' }) });
    await empty.conclude({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' });
    expect(deleted()).toEqual(['delete namespace']);
  });

  it('is kept when the save fails, and is nothing to conclude when nothing ever ran in it', async () => {
    saveFails = true;
    const workspaces = createConversationWorkspaces({ resolver: resolver(async () => SHARED as never), registry, kube, documents });
    await expect(workspaces.conclude({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' })).rejects.toThrow('Gitea is down');
    expect(deleted()).toEqual([]);

    namespaceExists = false;
    expect(await workspaces.conclude({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' })).toEqual({ saved: false, why: 'nothing ever ran in this conversation\'s workspace' });
    expect(deleted()).toEqual([]);
  });
});
