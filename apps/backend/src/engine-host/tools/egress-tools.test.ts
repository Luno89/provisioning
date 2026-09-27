import { describe, it, expect } from 'vitest';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import { createEgressTools } from './egress-tools.js';

function tools(grants: EgressGrantRecord[] = []) {
  const requests: EgressRequest[] = [];
  const handlers = createEgressTools({
    newId: () => 'e1',
    now: () => 't',
    stores: {
      grants: async () => grants,
      requests: { list: async () => requests, save: async (request) => { requests.push(request); } },
      trees: { list: async () => [{ id: 't1', ownerId: 'u1', name: 'n', type: 'x', goal: 'g', projectIds: ['p1'], createdAt: 'x', updatedAt: 'x' }] },
    },
  });
  const ask = (parsed: Record<string, unknown>) => handlers.request_egress!({
    name: 'request_egress', parsed, driver: undefined, caller: { ownerId: 'u1', agentSlug: 'executor', projectId: 'p1', runId: 'r1' },
  });
  return { ask, requests };
}

describe('request_egress', () => {
  it('asks once for a host, filed under the tree the run works for', async () => {
    const { ask, requests } = tools();
    expect((await ask({ host: 'https://API.stripe.com/v1/charges', why: 'charge a card in the tests' })).content).toContain('Asked the person to let you reach api.stripe.com');
    expect((await ask({ host: 'api.stripe.com', why: 'again' })).content).toContain('Already asked');
    expect(requests).toEqual([expect.objectContaining({ host: 'api.stripe.com', agentSlug: 'executor', treeId: 't1', status: 'requested', runId: 'r1' })]);
  });

  it('says so when the host is already granted, and refuses an address or no reason', async () => {
    const granted: EgressGrantRecord = { id: 'g', ownerId: 'u1', agentSlug: 'executor', host: 'api.stripe.com', approvedBy: 'u1', approvedAt: 't' };
    expect((await tools([granted]).ask({ host: 'api.stripe.com', why: 'x' })).content).toContain('already granted');
    const { ask, requests } = tools();
    expect((await ask({ host: '1.2.3.4', why: 'x' })).digest).toContain('not an address');
    expect((await ask({ host: 'api.stripe.com' })).digest).toContain('say why');
    expect(requests).toEqual([]);
  });
});
