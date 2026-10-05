import { describe, it, expect, vi } from 'vitest';
import type { NodeImplementation } from '@koala/agent-engine/procedure';
import { createEnvironmentNodes } from './environment-nodes.js';
import type { HostNodeServices } from './services.js';

const SHARED = { kind: 'sandbox', id: 'engine-conversation-c1', capabilities: { lifecycle: 'persistent' }, workspace: { runId: 'conversation-c1', sharedBy: 'conversation' } };
const OWN = { kind: 'sandbox', id: 'engine-run-1', capabilities: {}, workspace: { runId: 'run-1' } };

const provisionWith = (services: Partial<HostNodeServices>) => {
  const nodes = createEnvironmentNodes({
    environments: { describe: vi.fn(async () => OWN), release: vi.fn(async () => undefined) },
    ...services,
  } as unknown as HostNodeServices);
  const provision = nodes.find((node) => node.kind === 'provision-sandbox') as Extract<NodeImplementation, { role: 'step' }>;
  return (run: { depth: number; conversationId?: string; environment?: unknown }) => provision.run({
    node: { id: 'provision', kind: 'provision-sandbox', settings: {} },
    inputs: {},
    run: {
      identity: { runId: 'run-1', depth: run.depth, agentId: 'koala', trigger: 'user' },
      launch: { ownerId: 'u1', ...(run.conversationId ? { conversationId: run.conversationId } : {}), ...(run.environment ? { environment: run.environment } : {}) },
      budget: {},
      emit: () => undefined,
    },
  } as never);
};

describe('provisioning a run\'s environment', () => {
  it('gives a top-level run in a conversation the conversation\'s workspace, described for its agent', async () => {
    const describe = vi.fn(async () => SHARED);
    const outcome = await provisionWith({ conversationWorkspaces: { describe } as never })({ depth: 0, conversationId: 'c1' });

    expect(outcome).toEqual({ exit: 'ready', outputs: { environment: SHARED } });
    expect(describe).toHaveBeenCalledWith({ conversationId: 'c1', ownerId: 'u1', agentSlug: 'koala' });
  });

  it('falls back to the run\'s own environment when nothing it can reach works in a sandbox, or there is no conversation', async () => {
    const describe = vi.fn(async () => undefined);
    const provision = provisionWith({ conversationWorkspaces: { describe } as never });

    expect(await provision({ depth: 0, conversationId: 'c1' })).toEqual({ exit: 'ready', outputs: { environment: OWN } });
    expect(await provision({ depth: 0 })).toEqual({ exit: 'ready', outputs: { environment: OWN } });
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('lets a child work in what it was handed rather than describing the conversation\'s workspace again', async () => {
    const describe = vi.fn(async () => SHARED);
    const outcome = await provisionWith({ conversationWorkspaces: { describe } as never })({ depth: 1, conversationId: 'c1', environment: SHARED });

    expect(outcome).toEqual({ exit: 'ready', outputs: { environment: { ...SHARED, handedOver: true } } });
    expect(describe).not.toHaveBeenCalled();
  });

  it('says why when the conversation\'s workspace cannot be provided', async () => {
    const describe = vi.fn(async () => { throw new Error('the image failed to build'); });
    const outcome = await provisionWith({ conversationWorkspaces: { describe } as never })({ depth: 0, conversationId: 'c1' });

    expect(outcome).toEqual({ exit: 'unavailable', outputs: { reason: 'the conversation\'s workspace could not be provided: the image failed to build' } });
  });
});

describe('releasing a run\'s environment', () => {
  const releaseWith = (services: Partial<HostNodeServices>, environment: unknown, conversationId?: string) => {
    const release = vi.fn(async () => undefined);
    const emitted: unknown[] = [];
    const nodes = createEnvironmentNodes({ environments: { describe: vi.fn(), release }, ...services } as unknown as HostNodeServices);
    const node = nodes.find((entry) => entry.kind === 'release-sandbox') as Extract<NodeImplementation, { role: 'step' }>;
    const outcome = node.run({
      node: { id: 'release', kind: 'release-sandbox', settings: {} },
      inputs: { environment },
      run: { identity: { runId: 'run-1', depth: 0, agentId: 'koala', trigger: 'user' }, launch: { ownerId: 'u1', ...(conversationId ? { conversationId } : {}) }, budget: {}, emit: (event: unknown) => emitted.push(event) },
    } as never);
    return { outcome, release, emitted };
  };

  it('saves the conversation\'s workspace at the end of every turn and keeps it for the next one', async () => {
    const save = vi.fn(async () => ({ saved: true as const, owner: 'koala-u1', repo: 'research-c1', commit: 'abc' }));
    const { outcome, release } = releaseWith({ conversationWorkspaces: { describe: vi.fn(), save } as never }, SHARED, 'c1');

    expect(await outcome).toEqual({ exit: 'done' });
    expect(save).toHaveBeenCalledWith({ conversationId: 'c1', ownerId: 'u1' });
    expect(release).not.toHaveBeenCalled();
  });

  it('warns, without failing the turn, when the save does not work', async () => {
    const save = vi.fn(async () => { throw new Error('Gitea is down'); });
    const { outcome, emitted } = releaseWith({ conversationWorkspaces: { describe: vi.fn(), save } as never }, SHARED, 'c1');

    expect(await outcome).toEqual({ exit: 'done' });
    expect(emitted).toEqual([{ type: 'notice', level: 'info', message: 'this conversation\'s documents were not saved yet: Gitea is down' }]);
  });

  it('leaves a handed workspace to whoever handed it, and releases a run\'s own', async () => {
    const save = vi.fn();
    const handed = releaseWith({ conversationWorkspaces: { describe: vi.fn(), save } as never }, { ...SHARED, handedOver: true }, 'c1');
    await handed.outcome;
    expect(save).not.toHaveBeenCalled();
    expect(handed.release).not.toHaveBeenCalled();

    const own = releaseWith({ conversationWorkspaces: { describe: vi.fn(), save } as never }, OWN, 'c1');
    await own.outcome;
    expect(save).not.toHaveBeenCalled();
    expect(own.release).toHaveBeenCalledWith('run-1');
  });
});
