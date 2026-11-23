import { describe, expect, it } from 'vitest';
import type { Reopening } from '@koala/engine-core/reopening';
import { untilTemporalSetUp, type TemporalSetUpAsks } from './temporal-setup.js';

const grpc = (code: number, message: string): Error => Object.assign(new Error(message), { code, details: message, metadata: {} });

function temporalAnswering(answers: { namespace: (() => unknown)[]; attributes: (() => Record<string, number>)[] }) {
  const asked = { namespace: 0, attributes: 0 };
  const next = <T>(list: (() => T)[], at: number): T => (list[Math.min(at, list.length - 1)]!)();
  const asks: TemporalSetUpAsks = {
    workflowService: { describeNamespace: async () => next(answers.namespace, asked.namespace++) },
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
