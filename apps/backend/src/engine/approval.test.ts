import { describe, it, expect, vi } from 'vitest';
import { allowAll, createApprovalGate, denyAll, type ApprovalAsk } from './approval.js';
import type { EnvironmentHandle } from '@koala/engine-core';

const handle = (approval: EnvironmentHandle['approval'], id = 'env-1'): EnvironmentHandle => ({
  id,
  spec: { kind: approval === 'per-command' ? 'machine' : 'sandbox', lifecycle: 'persistent' },
  capabilities: { terminal: true, filesystem: true, egress: true, git: true, languages: [] },
  approval,
});

const ask = (over: Partial<ApprovalAsk> = {}): ApprovalAsk => ({
  handle: handle('per-command'),
  request: { command: 'rm -rf build' },
  runId: 'run-1',
  agentSlug: 'executor',
  ...over,
});

describe('approval gate', () => {
  it('lets a sandbox run without asking anyone', async () => {
    const decide = vi.fn(async () => 'allow' as const);
    const gate = createApprovalGate({ decide });

    expect(await gate.guard(ask({ handle: handle('none') }))).toEqual({ allowed: true });
    expect(decide).not.toHaveBeenCalled();
  });

  it('asks before running a command on a real machine', async () => {
    const decide = vi.fn(async () => 'allow' as const);
    const gate = createApprovalGate({ decide });

    expect(await gate.guard(ask())).toEqual({ allowed: true });
    expect(decide).toHaveBeenCalledTimes(1);
    expect((decide.mock.calls as unknown as ApprovalAsk[][])[0]?.[0])
      .toMatchObject({ request: { command: 'rm -rf build' }, agentSlug: 'executor' });
  });

  it('blocks the command when the person says no, and says why', async () => {
    const gate = denyAll();
    expect(await gate.guard(ask())).toEqual({ allowed: false, reason: 'You declined to run that command.' });
  });

  it('asks again for every command by default', async () => {
    const decide = vi.fn(async () => 'allow' as const);
    const gate = createApprovalGate({ decide });

    await gate.guard(ask({ request: { command: 'ls' } }));
    await gate.guard(ask({ request: { command: 'cat package.json' } }));

    expect(decide).toHaveBeenCalledTimes(2);
  });

  it('stops asking for the rest of a run once told to allow it', async () => {
    const decide = vi.fn(async () => 'allow-for-run' as const);
    const gate = createApprovalGate({ decide });

    await gate.guard(ask({ request: { command: 'npm test' } }));
    await gate.guard(ask({ request: { command: 'npm run build' } }));

    expect(decide).toHaveBeenCalledTimes(1);
    expect(gate.standingApprovals()).toEqual(['run-1|env-1']);
  });

  it('keeps a standing approval scoped to its own run and machine', async () => {
    const decide = vi.fn(async () => 'allow-for-run' as const);
    const gate = createApprovalGate({ decide });

    await gate.guard(ask({ runId: 'run-1' }));
    await gate.guard(ask({ runId: 'run-2' }));
    await gate.guard(ask({ runId: 'run-1', handle: handle('per-command', 'env-2') }));

    expect(decide).toHaveBeenCalledTimes(3);
  });

  it('reports each ask so the UI can show what is waiting', async () => {
    const onAsk = vi.fn();
    const gate = createApprovalGate({ decide: async () => 'allow', onAsk });

    await gate.guard(ask({ request: { command: 'git push' } }));

    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk.mock.calls[0]?.[0]).toMatchObject({ request: { command: 'git push' } });
  });

  it('allowAll still never bothers a sandbox', async () => {
    const gate = allowAll();
    expect(await gate.guard(ask({ handle: handle('none') }))).toEqual({ allowed: true });
    expect(await gate.guard(ask())).toEqual({ allowed: true });
  });
});
