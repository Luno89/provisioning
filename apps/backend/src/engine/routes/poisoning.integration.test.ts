import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import type { MemoryItem } from '../../memory/index.js';
import type { PoisoningSignal } from '../lib/poisoning.js';
import { PoisoningService } from '../services/PoisoningService.js';
import { poisoningRouter } from './poisoning.js';
import { standInIndexing } from '../../memory/testing/memory-index.js';

const indexing = await standInIndexing();

const quiet = { validateStatus: () => true };
const at = '2026-10-29T10:00:00.000Z';

const signal = (over: Partial<PoisoningSignal>): PoisoningSignal => ({
  id: 's1', ownerId: TEST_USER.id, kind: 'private-out', severity: 'high', state: 'open', at, readsKey: 'grant-1', runId: 'run-1', tool: 'fetch_web_page',
  said: 'fetch_web_page sent out 40 characters this run read from file, to attacker.example', sealedMatch: 'sealed:the secret line', host: 'attacker.example', ...over,
});
const memory = (id: string, over: Partial<MemoryItem>): MemoryItem => ({
  id, ownerId: TEST_USER.id, category: 'lessons_learned', scope: 'global', status: 'active', title: id, text: id, createdAt: at, updatedAt: at, ...over,
});

type Signals = { signals: Array<{ id: string; state: string; matched?: string }> };

let harness: Harness;

beforeAll(async () => {
  harness = await mountRouter({
    prefix: '/api/poisoning',
    router: (db) => poisoningRouter({
      poisoning: new PoisoningService({
        store: db.engine,
        memories: { list: (ownerId) => db.memory.getMemories(ownerId), save: (item) => db.memory.saveMemory(item), ...indexing },
        unseal: (sealed) => sealed.replace(/^sealed:/, ''),
        push: async () => 1,
        mail: async () => undefined,
        now: () => '2026-10-29T11:00:00.000Z',
        log: () => undefined,
      }),
    }),
  });
  await harness.db.engine.openRunReads('grant-1', TEST_USER.id, 'run-1', 'k', at);
});

afterAll(async () => { await harness.close(); });

describe('/api/poisoning over HTTP', () => {
  it('lists the signed-in person\'s open findings, every one when asked, and one run\'s when a run is named', async () => {
    await harness.db.engine.savePoisoningSignal(signal({ id: 'open-one' }));
    await harness.db.engine.savePoisoningSignal(signal({ id: 'closed-one', state: 'dismissed' }));
    await harness.db.engine.savePoisoningSignal(signal({ id: 'theirs', ownerId: 'someone-else' }));

    const open = await axios.get<Signals>(harness.url('/api/poisoning'));
    expect(open.data.signals.map((one) => one.id)).toEqual(['open-one']);
    expect(open.data.signals[0]).toMatchObject({ matched: 'the secret line' });
    expect((await axios.get<Signals>(harness.url('/api/poisoning?all=1'))).data.signals.map((one) => one.id).sort()).toEqual(['closed-one', 'open-one']);
    expect((await axios.get<Signals>(harness.url('/api/poisoning?runId=run-1'))).data.signals.map((one) => one.id).sort()).toEqual(['closed-one', 'open-one']);
  });

  it('dismisses a finding with the reason the person gave, and answers one that is not theirs with the service\'s status', async () => {
    await harness.db.engine.savePoisoningSignal(signal({ id: 'to-dismiss' }));
    await harness.db.engine.savePoisoningSignal(signal({ id: 'not-mine', ownerId: 'someone-else' }));
    expect((await axios.post(harness.url('/api/poisoning/to-dismiss/dismiss'), { because: 'it was me' })).data).toMatchObject({ id: 'to-dismiss', state: 'dismissed' });
    const missing = await axios.post<{ error: string }>(harness.url('/api/poisoning/not-mine/dismiss'), {}, quiet);
    expect(missing.status).toBe(404);
    expect(typeof missing.data.error).toBe('string');
  });

  it('retires what a run left, and refuses any scope but run or source', async () => {
    await harness.db.engine.savePoisoningSignal(signal({ id: 'to-retire' }));
    await harness.db.memory.saveMemory(memory('from-run', { provenance: { experimentId: 'run-1' } }));
    const retired = await axios.post<{ retired: number; signal: { id: string } }>(harness.url('/api/poisoning/to-retire/retire'), { scope: 'run' });
    expect(retired.data).toMatchObject({ retired: 1, signal: { id: 'to-retire' } });
    expect((await harness.db.memory.getMemories(TEST_USER.id)).find((item) => item.id === 'from-run')?.invalidAt).toBeTruthy();

    const refused = await axios.post(harness.url('/api/poisoning/to-retire/retire'), { scope: 'everything' }, quiet);
    expect(refused).toMatchObject({ status: 400, data: { error: 'say what to retire: "run" for what this run left, or "source" for everything learned from the host it names' } });
  });
});
