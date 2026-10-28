import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionProposal } from '../../engine/lib/action-proposals.js';
import { createMonitoringTools, type MonitoringReading } from './handlers.js';
import { APP_HEALTH, MONITORING_OVERVIEW, PROPOSE_ALERT } from './catalogue.js';
import { asPerson } from '../../platform/lib/permissions.js';

const caller = { ownerId: 'me', conversationId: 'conv-1', runId: 'run-1' };
let saved: ActionProposal[];
let asked: string[];

const reading: MonitoringReading = {
  monitoring: {
    describeOverview: async () => 'Nothing needs attention.',
    describeApp: async (_viewer, app) => { if (app !== 'Books') throw new Error('no app called Nope; yours are: Books'); return 'Books is healthy.\nUp 100% over the last day.'; },
    describeCluster: async () => 'c is healthy.',
    proposeAlertProblem: async (_viewer, app, spec) => {
      asked.push(`${app}:${spec.kind}:${spec.threshold}:${spec.forMinutes}`);
      return app === 'Books' ? { subject: { id: 'books', name: 'Books' }, summary: 'Tell me when Books has not answered for 5 minutes' } : { error: 'no app called Nope; yours are: Books' };
    },
  },
  rules: async () => [{ id: 'r1', summary: 'Books: down', deploymentId: 'books' }],
  viewer: async (ownerId) => asPerson(ownerId),
};

const tools = (withReading = true) => createMonitoringTools({
  ...(withReading ? { reading } : {}),
  proposals: { list: async () => saved, save: async (proposal) => { saved.push(proposal); } },
  now: () => 'now',
  newId: () => `p${saved.length}`,
});

const call = (name: string, parsed: Record<string, unknown>, which = tools()) => which[name]!({ parsed, caller } as never);

beforeEach(() => { saved = []; asked = []; });

describe('the monitoring tools', () => {
  it('read through the same service the page uses', async () => {
    expect(await call(MONITORING_OVERVIEW, {})).toMatchObject({ ok: true, content: 'Nothing needs attention.' });
    expect(await call(APP_HEALTH, { app: 'Books' })).toMatchObject({ ok: true, digest: 'Books is healthy.' });
    expect(await call(APP_HEALTH, { app: 'Nope' })).toMatchObject({ ok: false, content: 'no app called Nope; yours are: Books' });
  });

  it('refuse where monitoring cannot be read', async () => {
    expect(await call(MONITORING_OVERVIEW, {}, tools(false))).toMatchObject({ ok: false, content: 'monitoring cannot be read here' });
  });

  it('put an alert on a card, once', async () => {
    expect(await call(PROPOSE_ALERT, { app: 'Books', kind: 'down', why: 'they asked' })).toMatchObject({ ok: true, digest: 'proposed: Tell me when Books has not answered for 5 minutes' });
    expect(saved[0]).toMatchObject({ kind: 'set_alert', params: { deploymentId: 'books', kind: 'down', threshold: '0', forMinutes: '5' }, conversationId: 'conv-1', status: 'proposed' });
    expect(await call(PROPOSE_ALERT, { app: 'Books', kind: 'down', why: 'again' })).toMatchObject({ ok: true, digest: expect.stringContaining('already proposed') });
    expect(saved).toHaveLength(1);
  });

  it('take a threshold sent as text, and refuse one out of range before asking the cluster', async () => {
    await call(PROPOSE_ALERT, { app: 'Books', kind: 'slow', threshold: '1.5', forMinutes: 3, why: 'w' });
    expect(asked).toEqual(['Books:slow:1.5:3']);
    expect(await call(PROPOSE_ALERT, { app: 'Books', kind: 'memory', threshold: 500, why: 'w' })).toMatchObject({ ok: false, content: expect.stringContaining('between 10 and 100') });
    expect(asked).toHaveLength(1);
  });

  it('refuse an unknown kind, a missing why and an unknown app', async () => {
    expect(await call(PROPOSE_ALERT, { app: 'Books', kind: 'vibes', why: 'w' })).toMatchObject({ ok: false });
    expect(await call(PROPOSE_ALERT, { app: 'Books', kind: 'down' })).toMatchObject({ ok: false, content: 'say why, for the person to read on the card' });
    expect(await call(PROPOSE_ALERT, { app: 'Nope', kind: 'down', why: 'w' })).toMatchObject({ ok: false, content: 'no app called Nope; yours are: Books; nothing was proposed' });
    expect(saved).toEqual([]);
  });

  it('propose removing an alert by its id', async () => {
    expect(await call(PROPOSE_ALERT, { app: 'Books', remove: 'r1', why: 'too noisy' })).toMatchObject({ ok: true, digest: 'proposed: Stop alerting: Books: down' });
    expect(saved[0]?.params).toEqual({ remove: 'r1' });
    expect(await call(PROPOSE_ALERT, { app: 'Books', remove: 'r9', why: 'w' })).toMatchObject({ ok: false });
  });
});
