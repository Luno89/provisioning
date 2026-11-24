import { describe, expect, it } from 'vitest';
import type { Reopening } from '@koala/engine-core/reopening';
import { onceNamespaceKnown, untilConnected, untilTemporalSetUp, type TemporalSetUpAsks } from './temporal-setup.js';

const grpc = (code: number, message: string): Error => Object.assign(new Error(message), { code, details: message, metadata: {} });

function temporalAnswering(answers: { namespace: (() => unknown)[]; attributes: (() => Record<string, number>)[]; query?: (() => unknown)[] }) {
  const asked = { namespace: 0, attributes: 0, query: 0 };
  const next = <T>(list: (() => T)[], at: number): T => (list[Math.min(at, list.length - 1)]!)();
  const asks: TemporalSetUpAsks = {
    workflowService: { describeNamespace: async () => next(answers.namespace, asked.namespace++), listWorkflowExecutions: async () => next(answers.query ?? [() => ({ executions: [] })], asked.query++) },
    operatorService: { listSearchAttributes: async () => ({ customAttributes: next(answers.attributes, asked.attributes++) }) },
  };
  return { asks, asked };
}

function askedAgain() {
  let times = 0;
  const again: Reopening = {
    get seconds() { return 5; },
    take: () => 5000,
    later: () => { throw new Error('the wait is asked again through after()'); },
    after: async () => { times += 1; },
    reset: () => undefined,
  };
  return { again, times: () => times };
}

const there = () => ({ namespaceInfo: { name: 'default' } });

describe('waiting for Temporal\'s namespace to be set up', () => {
  it('waits while the namespace is not there or an attribute Koala uses is not listed, saying what is missing, and ends once both are', async () => {
    const { asks } = temporalAnswering({
      namespace: [() => { throw grpc(5, '5 NOT_FOUND: Namespace default is not found.'); }, there],
      attributes: [() => ({ KoalaOwner: 2 }), () => ({ KoalaOwner: 2, KoalaProject: 2 })],
    });
    const { again, times } = askedAgain();
    const said: string[] = [];

    await untilTemporalSetUp(asks, 'default', (line) => said.push(line), again);

    expect(said).toEqual([
      'waiting for Temporal\'s namespace default to be set up: the namespace is not there yet',
      'waiting for Temporal\'s namespace default to be set up: KoalaProject is not registered yet',
    ]);
    expect(times()).toBe(2);
  });

  it('waits while Temporal lists the attributes but cannot yet use them in a query, and ends once a query by them is answered', async () => {
    const { asks, asked } = temporalAnswering({
      namespace: [there],
      attributes: [() => ({ KoalaOwner: 2, KoalaProject: 2 })],
      query: [() => { throw grpc(3, '3 INVALID_ARGUMENT: Namespace default has no mapping defined for search attribute KoalaOwner'); }, () => ({ executions: [] })],
    });
    const { again, times } = askedAgain();
    const said: string[] = [];

    await untilTemporalSetUp(asks, 'default', (line) => said.push(line), again);

    expect(said).toEqual(['waiting for Temporal\'s namespace default to be set up: Temporal lists KoalaOwner and KoalaProject but cannot use them in a query yet']);
    expect(asked.query).toBe(2);
    expect(times()).toBe(1);
  });

  it('keeps waiting while Temporal is unavailable, with its reason', async () => {
    const { asks } = temporalAnswering({
      namespace: [() => { throw grpc(14, '14 UNAVAILABLE: No connection established'); }, there],
      attributes: [() => ({ KoalaOwner: 2, KoalaProject: 2 })],
    });
    const { again } = askedAgain();
    const said: string[] = [];

    await untilTemporalSetUp(asks, 'default', (line) => said.push(line), again);

    expect(said).toEqual(['waiting for Temporal\'s namespace default to be set up: it is unavailable: 14 UNAVAILABLE: No connection established']);
  });

  it('adds the search attributes once Temporal\'s frontend knows the namespace it just registered, saying it waits until then', async () => {
    const answers = [() => { throw grpc(5, '5 NOT_FOUND: Namespace default is not found.'); }, () => undefined];
    let added = 0;
    const { again, times } = askedAgain();
    const said: string[] = [];

    await onceNamespaceKnown(async () => { answers[added++]!(); }, 'default', (line) => said.push(line), again);

    expect(said).toEqual(['waiting for Temporal\'s frontend to know the namespace default it registered, to add the search attributes Koala uses']);
    expect([added, times()]).toEqual([2, 1]);
  });

  it('ends at once with the reason when adding the search attributes is refused for any other reason', async () => {
    const { again, times } = askedAgain();

    await expect(onceNamespaceKnown(async () => { throw grpc(7, '7 PERMISSION_DENIED: Request unauthorized.'); }, 'default', () => undefined, again)).rejects.toThrow('7 PERMISSION_DENIED');
    expect(times()).toBe(0);
  });

  it('ends at once with the reason when Temporal refuses for good', async () => {
    const { asks, asked } = temporalAnswering({
      namespace: [() => { throw grpc(7, '7 PERMISSION_DENIED: Request unauthorized.'); }],
      attributes: [() => ({})],
    });
    const { again, times } = askedAgain();

    await expect(untilTemporalSetUp(asks, 'default', () => undefined, again)).rejects.toThrow('Temporal\'s namespace default cannot be set up: 7 PERMISSION_DENIED: Request unauthorized.');
    expect(asked.namespace).toBe(1);
    expect(times()).toBe(0);
  });
});

describe('connecting to a Temporal that is still starting', () => {
  it('asks again while Temporal does not answer yet, saying why, and hands on the connection once it does', async () => {
    const { again, times } = askedAgain();
    const said: string[] = [];
    let tries = 0;
    const connection = await untilConnected(async () => {
      tries += 1;
      if (tries < 3) throw new Error('Failed to connect before the deadline');
      return 'connected';
    }, (line) => said.push(line), again);

    expect(connection).toBe('connected');
    expect(times()).toBe(2);
    expect(said[0]).toContain('waiting for Temporal to answer: its connection did not open yet');
  });

  it('ends at once with the reason when the connection is refused for good', async () => {
    const { again, times } = askedAgain();
    await expect(untilConnected(async () => { throw new Error('the certificate Temporal shows is not signed by this install\'s CA'); }, () => undefined, again))
      .rejects.toThrow('Temporal cannot be reached: the certificate Temporal shows is not signed by this install\'s CA');
    expect(times()).toBe(0);
  });
});
