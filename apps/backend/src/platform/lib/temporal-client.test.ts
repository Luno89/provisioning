import { describe, it, expect, vi } from 'vitest';
import { onceOwnerMapped, ownerNotYetMapped, requireOwner, resolveOwnersWith } from './temporal-client.js';
import { UnownedWorkflowError, ownerIn, startedFor } from './workflow-owner.js';

const input = (owned: boolean) => ({
  workflowType: 'AgentRunWorkflow',
  headers: {},
  options: { workflowId: 'run-1', taskQueue: 'engine', args: [], ...(owned ? startedFor('bo') : {}) },
}) as never;

describe('every workflow the platform starts says whose it is', () => {
  it('refuses a start, or a signal-with-start, that does not name an owner, and starts nothing', async () => {
    const next = vi.fn(async () => 'started');
    await expect(requireOwner.start!(input(false), next)).rejects.toBeInstanceOf(UnownedWorkflowError);
    await expect(requireOwner.signalWithStart!(input(false), next)).rejects.toThrow(/AgentRunWorkflow run-1 was started without KoalaOwner/);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an owned start through untouched', async () => {
    const next = vi.fn(async () => 'started');
    await expect(requireOwner.start!(input(true), next)).resolves.toBe('started');
    expect(next).toHaveBeenCalledWith(input(true));
  });

  it('stamps a check space\'s workflow as its person\'s, so it shows among theirs', async () => {
    resolveOwnersWith(async (owner) => (owner === 'bo' ? 'person-1' : owner));
    try {
      const next = vi.fn(async (_input: { options: { typedSearchAttributes?: never } }) => 'started');
      await requireOwner.start!(input(true), next as never);
      expect(ownerIn(next.mock.calls[0]![0].options.typedSearchAttributes)).toBe('person-1');
    } finally {
      resolveOwnersWith(undefined);
    }
  });
});

describe('a start made before Temporal has mapped the owner attribute', () => {
  it('is made again until Temporal takes it, and any other refusal is passed on at once', async () => {
    let tries = 0
    const started = await onceOwnerMapped(async () => {
      tries += 1
      if (tries < 3) throw new Error('Namespace default has no mapping defined for search attribute KoalaOwner')
      return 'started'
    }, 1)
    expect(started).toBe('started')
    expect(tries).toBe(3)
    let other = 0
    await expect(onceOwnerMapped(async () => { other += 1; throw new Error('Workflow execution already started') }, 1)).rejects.toThrow(/already started/)
    expect(other).toBe(1)
    expect(ownerNotYetMapped(new Error('no mapping defined for search attribute KoalaOwner'))).toBe(true)
    expect(ownerNotYetMapped(new Error('no mapping defined for search attribute Other'))).toBe(false)
  })
})
