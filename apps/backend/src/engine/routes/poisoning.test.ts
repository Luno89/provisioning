import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { SignalView } from '../lib/poisoning.js';
import { PoisoningError, type PoisoningService } from '../services/PoisoningService.js';
import { mountInProcess, PERSON, type InProcess } from '../testing/in-process.js';
import { poisoningRouter } from './poisoning.js';

type Service = Pick<PoisoningService, 'list' | 'dismiss' | 'retire'>;

const signal: SignalView = { id: 's1', kind: 'canary', severity: 'high', state: 'open', at: 'x', runId: 'r1', tool: 'fetch_web_page', said: 'it said a canary' };

let poisoning: ReturnType<typeof mock<Service>>;
let app: InProcess;

beforeEach(async () => {
  poisoning = mock<Service>();
  app = await mountInProcess({ prefix: '/api/poisoning', router: () => poisoningRouter({ poisoning }) });
});

describe('/api/poisoning', () => {
  it('lists the open findings of the signed-in person', async () => {
    poisoning.list.mockResolvedValue([signal]);
    expect(await app.get('/api/poisoning')).toMatchObject({ status: 200, data: { signals: [{ id: 's1' }] } });
    expect(poisoning.list).toHaveBeenCalledWith(PERSON.id, { open: true });
  });

  it('lists every finding when asked, and one run\'s when a run is named', async () => {
    poisoning.list.mockResolvedValue([]);
    await app.get('/api/poisoning?all=1');
    expect(poisoning.list).toHaveBeenLastCalledWith(PERSON.id, { open: false });
    await app.get('/api/poisoning?runId=r1');
    expect(poisoning.list).toHaveBeenLastCalledWith(PERSON.id, { runIds: ['r1'] });
  });

  it('dismisses a finding with the reason the person gave, and without one when they gave none', async () => {
    poisoning.dismiss.mockResolvedValue(signal);
    expect(await app.post('/api/poisoning/s1/dismiss', { because: 'it was me' })).toMatchObject({ status: 200, data: { id: 's1' } });
    expect(poisoning.dismiss).toHaveBeenLastCalledWith(PERSON.id, 's1', 'it was me');
    await app.post('/api/poisoning/s1/dismiss', { because: 7 });
    expect(poisoning.dismiss).toHaveBeenLastCalledWith(PERSON.id, 's1', undefined);
  });

  it('retires what a run left or everything from a host, and refuses any other scope', async () => {
    poisoning.retire.mockResolvedValue({ retired: 2, signal });
    expect(await app.post('/api/poisoning/s1/retire', { scope: 'run' })).toMatchObject({ status: 200, data: { retired: 2, signal: { id: 's1' } } });
    expect(poisoning.retire).toHaveBeenLastCalledWith(PERSON.id, 's1', 'run');
    await app.post('/api/poisoning/s1/retire', { scope: 'source' });
    expect(poisoning.retire).toHaveBeenLastCalledWith(PERSON.id, 's1', 'source');

    expect(await app.post('/api/poisoning/s1/retire', { scope: 'everything' })).toMatchObject({ status: 400, data: { error: 'say what to retire: "run" for what this run left, or "source" for everything learned from the host it names' } });
    expect(poisoning.retire).toHaveBeenCalledTimes(2);
  });

  it('answers a finding that is not the person\'s with the status the service gave', async () => {
    poisoning.dismiss.mockRejectedValue(new PoisoningError(404, 'No such finding'));
    poisoning.retire.mockRejectedValue(new PoisoningError(409, 'It names no host'));
    expect(await app.post('/api/poisoning/nope/dismiss')).toMatchObject({ status: 404, data: { error: 'No such finding' } });
    expect(await app.post('/api/poisoning/s1/retire', { scope: 'source' })).toMatchObject({ status: 409, data: { error: 'It names no host' } });
  });

  it('lets any other failure through as an error', async () => {
    poisoning.list.mockRejectedValue(new Error('the store is down'));
    expect(await app.get('/api/poisoning')).toMatchObject({ status: 500, data: { error: 'the store is down' } });
  });
});
