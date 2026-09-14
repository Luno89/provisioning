import { describe, it, expect, vi } from 'vitest';
import { createRunEnvironments, environmentIdFor, type ProvisionForRun } from './run-environments.js';
import type { EnvironmentDriver, EnvironmentSpec } from '@koala/engine-core';
import type { RunTicket } from '../temporal/contracts.js';

const spec: EnvironmentSpec = { kind: 'sandbox', lifecycle: 'invocation', languages: ['node20'] };

const ticket = (runId: string): RunTicket => ({
  runId,
  depth: 0,
  ownerId: 'user-1',
  agentSlug: 'executor',
  trigger: 'user',
});

function driverFor(id: string, disposed: string[]): EnvironmentDriver {
  return {
    handle: () => ({ id, spec, capabilities: { terminal: true, filesystem: true, egress: true, git: true, languages: [] }, approval: 'none' }),
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFile: async () => '',
    writeFile: async () => undefined,
    listDir: async () => [],
    deleteFile: async () => undefined,
    dispose: async () => { disposed.push(id); },
  };
}

function harness(over: Partial<Parameters<typeof createRunEnvironments>[0]> = {}) {
  const disposed: string[] = [];
  const provisioned: ProvisionForRun[] = [];
  const clock = { now: 0 };

  const environments = createRunEnvironments({
    provision: async (request) => {
      provisioned.push(request);
      return driverFor(request.id, disposed);
    },
    now: () => clock.now,
    ...over,
  });

  return { environments, disposed, provisioned, clock };
}

describe('environmentIdFor', () => {
  it('is the same every time for the same run, so a retry re-attaches instead of leaving a pod behind', () => {
    expect(environmentIdFor('run-abc')).toBe(environmentIdFor('run-abc'));
  });

  it('gives different runs different environments', () => {
    expect(environmentIdFor('run-a')).not.toBe(environmentIdFor('run-b'));
  });

  it('produces a name a pod will actually accept', () => {
    const id = environmentIdFor('Run_ABC/child::1');

    expect(id).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(id.length).toBeLessThanOrEqual(63);
  });

  it('stays legal for a run id long enough to overflow the name limit', () => {
    const id = environmentIdFor(`run-${'x'.repeat(200)}`);

    expect(id.length).toBeLessThanOrEqual(63);
    expect(id.endsWith('-')).toBe(false);
  });
});

describe('run-owned environments', () => {
  it('gives a run one environment however many times it asks', async () => {
    const { environments, provisioned } = harness();

    const first = await environments.forRun({ ticket: ticket('run-1'), spec });
    const second = await environments.forRun({ ticket: ticket('run-1'), spec });

    expect(second).toBe(first);
    expect(provisioned).toHaveLength(1);
  });

  it('never hands one run the environment another run used', async () => {
    const { environments, provisioned } = harness();

    await environments.forRun({ ticket: ticket('run-1'), spec });
    await environments.release('run-1');
    await environments.forRun({ ticket: ticket('run-2'), spec });

    expect(provisioned.map((request) => request.id)).toEqual([
      environmentIdFor('run-1'),
      environmentIdFor('run-2'),
    ]);
  });

  it('tears the environment down when the run releases it', async () => {
    const { environments, disposed } = harness();

    await environments.forRun({ ticket: ticket('run-1'), spec });
    expect(await environments.release('run-1')).toBe(true);

    expect(disposed).toEqual([environmentIdFor('run-1')]);
    expect(environments.live()).toBe(0);
  });

  it('does not fail a release for a run that never took an environment', async () => {
    const { environments, disposed } = harness();

    expect(await environments.release('run-nothing')).toBe(false);
    expect(disposed).toEqual([]);
  });

  it('releases only once even if the workflow asks twice', async () => {
    const { environments, disposed } = harness();

    await environments.forRun({ ticket: ticket('run-1'), spec });
    await environments.release('run-1');
    await environments.release('run-1');

    expect(disposed).toHaveLength(1);
  });

  it('provisions once when two tool calls race for the environment', async () => {
    const { environments, provisioned } = harness();

    const [a, b] = await Promise.all([
      environments.forRun({ ticket: ticket('run-1'), spec }),
      environments.forRun({ ticket: ticket('run-1'), spec }),
    ]);

    expect(a).toBe(b);
    expect(provisioned).toHaveLength(1);
  });

  it('lets the run try again after provisioning failed, rather than caching the failure', async () => {
    const disposed: string[] = [];
    let attempt = 0;

    const environments = createRunEnvironments({
      provision: async (request) => {
        attempt += 1;
        if (attempt === 1) throw new Error('no capacity');
        return driverFor(request.id, disposed);
      },
    });

    await expect(environments.forRun({ ticket: ticket('run-1'), spec })).rejects.toThrow(/no capacity/);
    await expect(environments.forRun({ ticket: ticket('run-1'), spec })).resolves.toBeDefined();
  });

  it('sweeps an environment whose run never released it, and says so', async () => {
    const onLeak = vi.fn();
    const { environments, disposed, clock } = harness({ maxAgeMs: 60_000, onLeak });

    await environments.forRun({ ticket: ticket('run-1'), spec });
    clock.now = 30_000;
    expect(await environments.sweep()).toEqual([]);

    clock.now = 60_000;
    expect(await environments.sweep()).toEqual(['run-1']);

    expect(disposed).toHaveLength(1);
    expect(onLeak).toHaveBeenCalledWith('run-1', 60_000);
  });

  it('passes the run through so the pod can be owned by whoever started it', async () => {
    const { environments, provisioned } = harness();

    await environments.forRun({ ticket: ticket('run-1'), spec, scope: { worktree: 'wt-a' } });

    expect(provisioned[0]?.ticket.ownerId).toBe('user-1');
    expect(provisioned[0]?.scope).toEqual({ worktree: 'wt-a' });
  });
});
