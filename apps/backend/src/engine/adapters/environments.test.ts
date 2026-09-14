import { describe, it, expect, vi } from 'vitest';
import {
  createEnvironmentResolver, NoMachineAvailableError, type WorkspaceSource,
} from './environments.js';
import { createAgentRegistry } from './registry.js';
import { createRunEnvironments, environmentIdFor, type ProvisionForRun } from './run-environments.js';
import { createSandboxDriver } from '../drivers/sandbox.js';
import { denyAll } from '../approval.js';
import { SEEDED_AGENTS } from '../seeds.js';
import type { MachineBackend } from '../drivers/machine.js';
import type { EnvironmentHandleRef, RunTicket } from '../temporal/contracts.js';

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
    images: { ensure: async (plan) => plan.base, exists: async () => true },
    tools: async () => [],
    ...over,
  });

  return { resolver, environments, provision };
}

const scratchAgent = () => ({
  ...SEEDED_AGENTS.find((agent) => agent.slug === 'executor')!,
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
    expect(await resolver.describe(ticket('judge'))).toMatchObject({ kind: 'none', egress: false });
  });

  it('gives research the network without provisioning a sandbox', async () => {
    const { resolver, provision } = setup();

    expect(await resolver.describe(ticket('research'))).toMatchObject({ kind: 'none', egress: true });
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

    await expect(resolver.describe(ticket('odd'))).rejects.toThrow(/no base image called "cobol"/);
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
        status: 'approved' as const,
        approvedBy: 'luno',
        returns: 'rows',
        failures: [{ when: 'a bad query', says: 'the query failed' }],
        parameters: { type: 'object' as const, properties: { sql: { type: 'string', description: 'the query' } } },
        needsBinaries: ['psql'],
      }],
    });

    await expect(resolver.describe(ticket('needy'))).rejects.toThrow(/query_db needs psql/);
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
    const run = ticket('research');

    const driver = await resolver.forRun({ ticket: run, environment: await handleFor(resolver, run) });

    expect(driver?.handle().capabilities).toMatchObject({ egress: true, terminal: false });
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
