import type { ToolDefinition } from '@koala/agent-engine';
import { MAX_LIFETIME_MS } from './workspace.js';
import { describe, it, expect, vi } from 'vitest';
import {
  createEnvironmentResolver, NoMachineAvailableError, type WorkspaceSource,
} from './environments.js';
import type { PublishedWorkspace } from '../../lib/published-workspace.js';
import { createAgentRegistry } from '../registries/registry.js';
import { createRunEnvironments, environmentIdFor, type ProvisionForRun } from './run-environments.js';
import { createSandboxDriver } from '../drivers/sandbox.js';
import { denyAll } from '@koala/agent-engine';
import type { MachineBackend } from '../drivers/machine.js';
import type { EnvironmentHandleRef, RunTicket } from '../temporal/contracts.js';
import { seededAgents } from '../../extensions/seeds.js';

const ticket = (agentSlug: string, runId = 'run-1'): RunTicket => ({
  runId,
  depth: 0,
  ownerId: 'user-1',
  agentSlug,
  trigger: 'user',
});

const machineBackend = (): MachineBackend => ({
  exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => undefined),
  listDir: vi.fn(async () => []),
  deleteFile: vi.fn(async () => undefined),
});

const onMachine: WorkspaceSource = {
  forRun: async () => ({ kind: 'machine', deviceId: 'tallgeese', deviceName: 'Tallgeese', path: 'projects/thing' }),
};

function setup(over: Partial<Parameters<typeof createEnvironmentResolver>[0]> = {}) {
  const provision = vi.fn(async ({ id, spec, scope }: ProvisionForRun) =>
    createSandboxDriver({
      sandboxId: id,
      spec,
      ...(scope ? { scope } : {}),
      backend: {
        exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        readFile: vi.fn(async () => ''),
        writeFile: vi.fn(async () => undefined),
        listDir: vi.fn(async () => []),
        deleteFile: vi.fn(async () => undefined),
      },
    }));

  const environments = createRunEnvironments({ provision });
  const resolver = createEnvironmentResolver({
    registry: createAgentRegistry(),
    environments,
    images: { ensure: async (plan) => plan.base, exists: async () => true, start: async (plan) => ({ state: 'ready' as const, reference: plan.base }), standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }) },
    tools: async () => [],
    ...over,
  });

  return { resolver, environments, provision };
}

const scratchAgent = () => ({
  ...seededAgents().find((agent) => agent.slug === 'executor')!,
  slug: 'scratch',
  interface: {},
});

const handleFor = async (
  resolver: ReturnType<typeof createEnvironmentResolver>,
  run: RunTicket,
): Promise<EnvironmentHandleRef | undefined> => {
  const described = await resolver.describe(run);

  if (described.kind === 'sandbox') {
    return { id: described.id, spec: described.capabilities, workspace: described.workspace };
  }
  if (described.kind === 'machine') {
    return {
      id: `machine:${described.deviceId}`,
      spec: { kind: 'machine', lifecycle: 'persistent' },
      scope: { deviceId: described.deviceId, ...(described.path ? { path: described.path } : {}) },
    };
  }
  return undefined;
};

describe('describing a run environment', () => {
  it('gives an agent that needs nothing no machine at all', async () => {
    const { resolver } = setup();
    expect(await resolver.describe(ticket('planner'))).toMatchObject({ kind: 'none', egress: false });
  });

  it('gives research a sandbox with the network, to write what it finds in, without starting it yet', async () => {
    const { resolver, provision } = setup();

    expect(await resolver.describe(ticket('research'))).toMatchObject({ kind: 'sandbox', capabilities: { egress: true } });
    expect(provision).not.toHaveBeenCalled();
  });

  it('names the sandbox after the run, so the same run always resolves to the same pod', async () => {
    const { resolver } = setup({
      registry: createAgentRegistry({ agentStore: { list: async () => [scratchAgent()] } }),
    });

    const described = await resolver.describe(ticket('scratch', 'run-7'));

    expect(described).toMatchObject({ kind: 'sandbox', id: environmentIdFor('run-7') });
    expect(described).toMatchObject({ workspace: { runId: 'run-7', ownerId: 'user-1' } });
  });

  it('sends a workspace-pinned agent to the machine that holds the workspace', async () => {
    const { resolver } = setup({ workspaces: onMachine, machineBackend: machineBackend() });

    expect(await resolver.describe(ticket('executor'))).toMatchObject({
      kind: 'machine',
      deviceId: 'tallgeese',
      deviceName: 'Tallgeese',
      path: 'projects/thing',
    });
  });

  it('does not consult the workspace for an agent that never asked for one', async () => {
    const workspaces = { forRun: vi.fn(async () => undefined) };
    const { resolver } = setup({
      workspaces,
      registry: createAgentRegistry({ agentStore: { list: async () => [scratchAgent()] } }),
    });

    await resolver.describe(ticket('scratch'));

    expect(workspaces.forRun).not.toHaveBeenCalled();
  });

  it('builds on the base the agent asked for', async () => {
    const pythonic = {
      ...scratchAgent(),
      slug: 'pythonic',
      environmentSpec: { kind: 'sandbox' as const, lifecycle: 'invocation' as const, languages: ['python'] },
    };

    const { resolver } = setup({
      registry: createAgentRegistry({ agentStore: { list: async () => [pythonic] } }),
    });

    expect(await resolver.describe(ticket('pythonic'))).toMatchObject({
      workspace: {
        image: expect.stringContaining('python-312'),
        provides: expect.arrayContaining(['pip']),
      },
    });
  });

  it('refuses a base image nobody has heard of, rather than guessing one', async () => {
    const odd = {
      ...scratchAgent(),
      slug: 'odd',
      environmentSpec: { kind: 'sandbox' as const, lifecycle: 'invocation' as const, languages: ['cobol'] },
    };

    const { resolver } = setup({
      registry: createAgentRegistry({ agentStore: { list: async () => [odd] } }),
    });

    await expect(resolver.describe(ticket('odd'))).rejects.toThrow(/no language called "cobol"/);
  });

  it('refuses when a granted tool needs a binary nothing can install', async () => {
    const needy = { ...scratchAgent(), slug: 'needy', tools: ['query_db'] };

    const { resolver } = setup({
      registry: createAgentRegistry({ agentStore: { list: async () => [needy] } }),
      tools: async () => [{
        name: 'query_db',
        summary: 'Query a database',
        binding: 'environment' as const,
        effect: 'read' as const,
        idempotent: false,
        openWorld: false,
        returns: 'rows',
        failures: [{ when: 'a bad query', says: 'the query failed' }],
        parameters: { type: 'object' as const, properties: { sql: { type: 'string', description: 'the query' } } },
        needsBinaries: ['psql'],
      }],
    });

    await expect(resolver.describe(ticket('needy'))).rejects.toThrow(/query_db needs psql/);
  });

  it('keeps a sandbox alive a quarter longer than the run may take, and as long as allowed when the run has no time limit', async () => {
    const workspaces: WorkspaceSource = { forRun: async () => ({ kind: 'sandbox', spec: { languages: ['node'] } }) };
    const { resolver } = setup({ workspaces });

    expect(await resolver.describe(ticket('executor'), 60 * 60_000)).toMatchObject({ workspace: { lifetimeMs: 75 * 60_000 } });
    expect(await resolver.describe(ticket('executor'))).toMatchObject({ workspace: { lifetimeMs: MAX_LIFETIME_MS } });
  });

  it('carries the package-registry env and egress that make installs work at all', async () => {
    const workspaces: WorkspaceSource = { forRun: async () => ({ kind: 'sandbox', spec: { languages: ['node'] } }) };
    const { resolver } = setup({ workspaces });
    const described = await resolver.describe(ticket('executor'));

    expect(described).toMatchObject({
      workspace: {
        env: expect.arrayContaining([
          expect.objectContaining({ name: 'NPM_CONFIG_REGISTRY' }),
        ]),
        egress: expect.arrayContaining([
          expect.objectContaining({ namespace: 'koala-registry' }),
        ]),
      },
    });
  });

  it('gives a persona its granted hosts through its own proxy credential, and never an open network rule', async () => {
    const workspaces: WorkspaceSource = { forRun: async () => ({ kind: 'sandbox', spec: { languages: ['node'] } }) };
    const { resolver } = setup({
      workspaces,
      egress: {
        grants: async (_owner, slug) => (slug === 'executor' ? [{ host: 'api.stripe.com' }] : []),
        proxyUrl: (owner, slug) => `http://u-${owner}-${slug}:pw@egress-proxy.koala-egress.svc.cluster.local:8888`,
      },
    });
    const granted = await resolver.describe(ticket('executor'));
    if (granted.kind !== 'sandbox') throw new Error('expected a sandbox');
    expect(granted.workspace.env).toEqual(expect.arrayContaining([
      { name: 'HTTPS_PROXY', value: 'http://u-user-1-executor:pw@egress-proxy.koala-egress.svc.cluster.local:8888' },
    ]));
    expect(granted.workspace.egress.every((rule) => rule.cidr === undefined)).toBe(true);
    expect(granted.workspace.egress).toEqual(expect.arrayContaining([expect.objectContaining({ namespace: 'koala-egress' })]));
    expect(granted.workspace.grantedHosts).toEqual(['api.stripe.com']);
  });

  it('gives no credential to a persona with no grants', async () => {
    const workspaces: WorkspaceSource = { forRun: async () => ({ kind: 'sandbox', spec: { languages: ['node'] } }) };
    const { resolver } = setup({ workspaces, egress: { grants: async () => [], proxyUrl: () => 'http://x:y@proxy' } });
    const described = await resolver.describe(ticket('executor'));
    if (described.kind !== 'sandbox') throw new Error('expected a sandbox');
    expect(JSON.stringify(described.workspace.env)).not.toContain('x:y@');
    expect(described.workspace.grantedHosts).toBeUndefined();
  });

  it('treats an agent that does not exist as having no machine, rather than guessing one', async () => {
    const { resolver } = setup();
    expect(await resolver.describe(ticket('ghost'))).toMatchObject({ kind: 'none', egress: false });
  });
});

describe('using a run environment', () => {
  it('provisions the sandbox the run was given, once, however many tools call for it', async () => {
    const { resolver, provision } = setup({
      registry: createAgentRegistry({ agentStore: { list: async () => [scratchAgent()] } }),
    });

    const run = ticket('scratch');
    const handle = await handleFor(resolver, run);

    const first = await resolver.forRun({ ticket: run, environment: handle });
    const second = await resolver.forRun({ ticket: run, environment: handle });

    expect(second).toBe(first);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(first?.handle().capabilities).toMatchObject({ terminal: true, filesystem: true });
  });

  it('never provisions a sandbox for an agent whose environment is nothing', async () => {
    const { resolver, provision } = setup();
    const run = ticket('koala');

    const driver = await resolver.forRun({ ticket: run, environment: await handleFor(resolver, run) });

    expect(driver?.handle().capabilities).toMatchObject({ egress: false, terminal: false });
    expect(provision).not.toHaveBeenCalled();
  });

  it('routes to the machine the run was pinned to, and never provisions a pod for it', async () => {
    const { resolver, provision } = setup({ workspaces: onMachine, machineBackend: machineBackend() });
    const run = ticket('executor');

    const driver = await resolver.forRun({ ticket: run, environment: await handleFor(resolver, run) });

    expect(provision).not.toHaveBeenCalled();
    expect(driver?.handle()).toMatchObject({
      approval: 'per-command',
      scope: { deviceId: 'tallgeese', path: 'projects/thing' },
    });
  });

  it('puts a fan-out child on its own worktree of that machine', async () => {
    const { resolver } = setup({ workspaces: onMachine, machineBackend: machineBackend() });
    const run = ticket('executor');

    const driver = await resolver.forRun({
      ticket: run,
      environment: await handleFor(resolver, run),
      worktree: '.worktrees/child-2',
    });

    expect(driver?.handle().scope).toMatchObject({ worktree: '.worktrees/child-2' });
  });

  it('keeps the machine approval gate in force, so a decline blocks the command', async () => {
    const backend = machineBackend();
    const { resolver } = setup({ workspaces: onMachine, machineBackend: backend, approval: denyAll() });
    const run = ticket('executor');

    const driver = await resolver.forRun({ ticket: run, environment: await handleFor(resolver, run) });
    const result = await driver!.exec({ command: 'rm -rf build' });

    expect(result.exitCode).toBe(126);
    expect(backend.exec).not.toHaveBeenCalled();
  });

  it('says plainly when a run needs a local machine this server cannot reach', async () => {
    const { resolver } = setup({ workspaces: onMachine });
    const run = ticket('executor');
    const handle = await handleFor(resolver, run);

    await expect(resolver.forRun({ ticket: run, environment: handle }))
      .rejects.toThrow(NoMachineAvailableError);
  });

  it('tears the sandbox down when the run releases it, and gives the next run a new one', async () => {
    const { resolver, provision } = setup({
      registry: createAgentRegistry({ agentStore: { list: async () => [scratchAgent()] } }),
    });

    const first = ticket('scratch', 'run-a');
    await resolver.forRun({ ticket: first, environment: await handleFor(resolver, first) });
    await resolver.release('run-a');

    const second = ticket('scratch', 'run-b');
    await resolver.forRun({ ticket: second, environment: await handleFor(resolver, second) });

    expect(provision.mock.calls.map(([request]) => request.id)).toEqual([
      environmentIdFor('run-a'),
      environmentIdFor('run-b'),
    ]);
  });
});

describe('a sandbox shared by several agents', () => {
  const treeTicket = (): RunTicket => ({ runId: 'tree-t1', depth: 0, ownerId: 'user-1', agentSlug: 'grove-runner', trigger: 'user' });

  it('is built to carry every tool the agents working in it hold, and keeps its work on a volume', async () => {
    const { resolver } = setup();
    const shared = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor', 'judge', 'leaf-judge'] });

    expect(shared.id).toBe(environmentIdFor('tree-t1'));
    expect(shared.workspace).toMatchObject({ runId: 'tree-t1', persistent: true, lifetimeMs: MAX_LIFETIME_MS });
    expect(shared.capabilities).toMatchObject({ kind: 'sandbox', lifecycle: 'persistent' });
  });

  it('ignores agents that need no sandbox, and refuses when none of them does', async () => {
    const { resolver } = setup();

    await expect(resolver.describeShared({ ticket: treeTicket(), agents: ['planner', 'executor'] })).resolves.toMatchObject({ kind: 'sandbox' });
    await expect(resolver.describeShared({ ticket: treeTicket(), agents: ['planner', 'koala'] })).rejects.toThrow(/nothing to share/);
  });

  it('is the one pod every run handed it works in', async () => {
    const { resolver, provision } = setup();
    const shared = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'] });
    const handle = { id: shared.id, spec: shared.capabilities, workspace: shared.workspace };

    const first = await resolver.forRun({ ticket: ticket('executor', 'grove-t1-p1-leaf-a-task-1'), environment: handle });
    const second = await resolver.forRun({ ticket: ticket('judge', 'grove-t1-p1-judge-judge-1'), environment: handle });

    expect(second).toBe(first);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision.mock.calls[0]![0]).toMatchObject({ id: environmentIdFor('tree-t1'), workspace: { runId: 'tree-t1', persistent: true } });
  });
});

describe('what a tree adds to its shared workspace', () => {
  const base = { runId: 'r', ownerId: 'u', agent: 'a', image: 'i', provides: [], lifetimeMs: 1, cpu: '1', memory: '1Gi', egressMode: 'declared' as const,
    env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://mirror' }], egress: [{ namespace: 'koala-registry', ports: [4873] }] };

  it('adds its values and network rules, never overriding what the platform set, and no rule twice', async () => {
    const { withExtras } = await import('./environments.js');
    expect(withExtras(base, {
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://elsewhere' }, { name: 'SHOP_CURRENCY', value: 'EUR' }],
      egress: [{ namespace: 'koala-registry', ports: [4873] }, { namespace: 'shop-db' }, { namespace: 'shop-db' }],
    })).toMatchObject({
      env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://mirror' }, { name: 'SHOP_CURRENCY', value: 'EUR' }],
      egress: [{ namespace: 'koala-registry', ports: [4873] }, { namespace: 'shop-db' }],
    });
    expect(withExtras(base, undefined)).toBe(base);
  });
});

describe('a tree\'s published workspace', () => {
  const treeTicket = (): RunTicket => ({ runId: 'tree-t1', depth: 0, ownerId: 'user-1', agentSlug: 'grove-runner', trigger: 'user' });
  const file = JSON.stringify({ packages: { dnf: ['wkhtmltopdf'] }, env: [{ name: 'SHOP', value: 'demo' }] });

  function store(initial?: PublishedWorkspace) {
    const saved: PublishedWorkspace[] = initial ? [initial] : [];
    const described: string[] = [];
    return {
      saved,
      described,
      published: {
        get: async () => saved.at(-1),
        save: async (workspace: PublishedWorkspace) => { saved.push(workspace); },
        file: async () => file,
        describe: async (): Promise<never> => { described.push('again'); throw new Error('set per test'); },
      },
    };
  }

  it('is composed from the project\'s file the first time, with every line saying where it came from, and published', async () => {
    const ensured: string[][] = [];
    const kept = store();
    const { resolver } = setup({
      published: kept.published,
      now: () => '2026-10-12T00:00:00Z',
      images: { ensure: async (plan) => { ensured.push(plan.installs.map((install) => JSON.stringify(install))); return 'registry/koala/workspace:first'; }, exists: async () => true, start: async () => ({ state: 'ready' as const, reference: '' }), standing: async () => ({ state: 'ready' as const, reference: '' }) },
    });

    const shared = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' });

    expect(ensured[0]).toContain(JSON.stringify({ via: 'dnf', packages: ['wkhtmltopdf'] }));
    expect(shared.workspace.image).toBe('registry/koala/workspace:first');
    expect(shared.workspace.env).toContainEqual({ name: 'SHOP', value: 'demo' });
    expect(kept.saved).toEqual([expect.objectContaining({
      ownerId: 'user-1', treeId: 't1', image: 'registry/koala/workspace:first', env: [{ name: 'SHOP', value: 'demo' }], publishedAt: '2026-10-12T00:00:00Z',
      lines: expect.arrayContaining([{ install: { via: 'dnf', packages: ['wkhtmltopdf'] }, from: 'project' }]),
    })]);
  });

  const images = (built: string[] = []) => ({
    ensure: async (plan: { fingerprint: string }) => { built.push(plan.fingerprint); return `registry/koala/workspace:${plan.fingerprint.slice(0, 6)}`; },
    exists: async () => true,
    start: async () => ({ state: 'ready' as const, reference: '' }),
    standing: async () => ({ state: 'ready' as const, reference: '' }),
  });

  it('is what every later run works in, without building anything', async () => {
    const built: string[] = [];
    const { resolver } = setup({ published: store().published, images: images(built) });

    const first = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' });
    const later = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' });
    expect(later.workspace.image).toBe(first.workspace.image);
    expect(later.workspace.env).toContainEqual({ name: 'SHOP', value: 'demo' });
    expect(built).toHaveLength(1);
  });

  it('is built again, from the same version of the file, when an agent working in it gains what needs installing', async () => {
    const built: string[] = [];
    let catalogue: ToolDefinition[] = [];
    const kept = store();
    const { resolver } = setup({ published: kept.published, images: images(built), tools: async () => catalogue });
    await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' });

    catalogue = [{ name: 'run_command', binding: 'environment', needsBinaries: ['jq'], install: { via: 'dnf', packages: ['jq'] } } as ToolDefinition];
    const after = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' });

    expect(built).toHaveLength(2);
    expect(kept.saved.at(-1)).toMatchObject({ image: after.workspace.image, file: { packages: { dnf: ['wkhtmltopdf'] } } });
    expect(kept.saved.at(-1)!.lines.map((line) => line.from)).toEqual(expect.arrayContaining(['project', 'tool:run_command']));
  });

  it('tells the runs in it what main asks for that it does not have yet, and how far the rebuild has got', async () => {
    const kept = store();
    const { resolver } = setup({ published: kept.published, images: images() });
    expect((await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' })).workspace.coming).toBeUndefined();

    kept.published.file = async () => JSON.stringify({ packages: { dnf: ['wkhtmltopdf', 'jq'] }, env: [{ name: 'SHOP', value: 'demo' }] });
    const asked = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' });
    expect(asked.workspace.coming).toEqual({ what: ['dnf jq'], stage: 'to be rebuilt once the commit that asked for it reaches main' });
    expect(asked.workspace.image).toBe(kept.saved[0]!.image);
    expect(kept.saved).toHaveLength(1);

    kept.saved.push({ ...kept.saved[0]!, next: { runId: 'workspace-build-t1-abc', stage: 'failed', reason: 'No match for argument: jq', at: 't' } });
    expect((await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' })).workspace.coming).toEqual({ what: ['dnf jq'], stage: 'not rebuilt: the build failed — No match for argument: jq' });
  });

  it('moves a run already working in it onto a newer one at its next command', async () => {
    const kept = store();
    const { resolver, provision } = setup({ published: kept.published, images: images() });
    const first = await resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' });
    const handle = { id: first.id, spec: first.capabilities, workspace: first.workspace };
    await resolver.forRun({ ticket: ticket('executor', 'grove-t1-p1-leaf-a-task-1'), environment: handle });

    const newer = { packages: { dnf: ['wkhtmltopdf', 'jq'] } };
    const composed = await resolver.composeShared({ ticket: treeTicket(), agents: ['executor'], file: newer });
    kept.saved.push({ ...kept.saved.at(-1)!, file: newer, fingerprint: composed.plan.fingerprint, lines: composed.plan.lines ?? [], image: 'registry/koala/workspace:built-by-the-procedure' });
    kept.published.describe = async () => resolver.describeShared({ ticket: treeTicket(), agents: ['executor'], treeId: 't1' }) as never;
    await resolver.forRun({ ticket: ticket('executor', 'grove-t1-p1-leaf-a-task-1'), environment: handle });

    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision.mock.calls[1]![0]).toMatchObject({ workspace: { image: 'registry/koala/workspace:built-by-the-procedure', persistent: true } });
  });
});
