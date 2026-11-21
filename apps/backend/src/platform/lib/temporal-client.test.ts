import { describe, it, expect, vi } from 'vitest';
import { WORK_HEADER, WorkStopped, unnamedWork, withWorkFor, workFromHeaders, workHeader } from '@koala/engine-core/work-for';
import { namesItsWork, onceOwnerMapped, ownerNotYetMapped, requireOwner, resolveOwnersWith } from './temporal-client.js';
import { UnownedWorkflowError, ownerIn, startedFor } from './workflow-owner.js';

const open = async () => ({ owner: false, project: false });
const ownerRequired = requireOwner(open);

const input = (owned: boolean) => ({
  workflowType: 'AgentRunWorkflow',
  headers: {},
  options: { workflowId: 'run-1', taskQueue: 'engine', args: [], ...(owned ? startedFor('bo') : {}) },
}) as never;

describe('every workflow the platform starts says whose it is', () => {
  it('refuses a start, or a signal-with-start, that does not name an owner, and starts nothing', async () => {
    const next = vi.fn(async () => 'started');
    await expect(ownerRequired.start!(input(false), next)).rejects.toBeInstanceOf(UnownedWorkflowError);
    await expect(ownerRequired.signalWithStart!(input(false), next)).rejects.toThrow(/AgentRunWorkflow run-1 was started without KoalaOwner/);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an owned start through untouched', async () => {
    const next = vi.fn(async () => 'started');
    await expect(ownerRequired.start!(input(true), next)).resolves.toBe('started');
    expect(next).toHaveBeenCalledWith(input(true));
  });

  it('stamps a check space\'s workflow as its person\'s, so it shows among theirs', async () => {
    resolveOwnersWith(async (owner) => (owner === 'bo' ? 'person-1' : owner));
    try {
      const next = vi.fn(async (_input: { options: { typedSearchAttributes?: never } }) => 'started');
      await ownerRequired.start!(input(true), next as never);
      expect(ownerIn(next.mock.calls[0]![0].options.typedSearchAttributes)).toBe('person-1');
    } finally {
      resolveOwnersWith(undefined);
    }
  });
});

describe('work for a project being deleted, or an account being removed, is refused at its start', () => {
  const named = (work: Parameters<typeof workHeader>[0]) => ({ ...(input(true) as object), headers: { [WORK_HEADER]: workHeader(work) } }) as never;

  it('refuses a start, or a signal-with-start, of a deleting project\'s work in the words the person reads, and starts nothing', async () => {
    const next = vi.fn(async () => 'started');
    const deleting = requireOwner(async (work) => ({ owner: false, project: work.project === 'p1' }));
    await expect(deleting.start!(named({ owner: 'bo', project: 'p1' }), next)).rejects.toBeInstanceOf(WorkStopped);
    await expect(deleting.signalWithStart!(named({ owner: 'bo', project: 'p1' }), next)).rejects.toThrow('this project is being deleted');
    expect(next).not.toHaveBeenCalled();
    await expect(deleting.start!(named({ owner: 'bo', project: 'p2' }), next)).resolves.toBe('started');
  });

  it('refuses work of an account being removed, and lets through the removal\'s own', async () => {
    const next = vi.fn(async () => 'started');
    const removing = requireOwner(async () => ({ owner: true, project: false }));
    await expect(removing.start!(named({ owner: 'bo' }), next)).rejects.toThrow('this account is being removed');
    await expect(removing.start!(named({ owner: 'bo', removing: 'owner' }), next)).resolves.toBe('started');
  });

  it('reads no marks for a start no work names', async () => {
    const read = vi.fn(async () => ({ owner: true, project: true }));
    await expect(requireOwner(read).start!(input(true), vi.fn(async () => 'started'))).resolves.toBe('started');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('every workflow the platform starts says whose work it is, so a removal can fence it', () => {
  const headersOf = async (start: () => Promise<unknown>, next: ReturnType<typeof vi.fn>) => {
    await start();
    return workFromHeaders((next.mock.calls[0]![0] as { headers: Record<string, never> }).headers);
  };

  it('names the owner the start names, before a check space is taken for its person', async () => {
    const next = vi.fn(async () => 'started');
    expect(await headersOf(() => namesItsWork.start!(input(true), next as never), next)).toEqual({ owner: 'bo' });
  });

  it('carries the project of the work it is started from, beside the owner the start names', async () => {
    const next = vi.fn(async () => 'started');
    expect(await headersOf(() => withWorkFor({ owner: 'someone', project: 'p1' }, () => namesItsWork.start!(input(true), next as never)), next)).toEqual({ owner: 'bo', project: 'p1' });
  });

  it('names the project in Temporal itself, beside the owner, so a deletion lists the project\'s open work from Temporal', async () => {
    const next = vi.fn(async (_input: { options: { typedSearchAttributes: { key: { name: string }; value: unknown }[] } }) => 'started');
    await withWorkFor({ project: 'p1' }, () => namesItsWork.start!(input(true), next as never));
    expect(next.mock.calls[0]![0].options.typedSearchAttributes.map((pair) => [pair.key.name, pair.value])).toEqual([['KoalaOwner', 'bo'], ['KoalaProject', 'p1']]);
  });

  it('names nothing for a start made by a removal\'s own step, whose work must never be fenced', async () => {
    const next = vi.fn(async () => 'started');
    expect(await headersOf(() => unnamedWork(() => namesItsWork.start!(input(true), next as never)), next)).toBeUndefined();
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
