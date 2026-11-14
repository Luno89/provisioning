import { describe, it, expect, afterAll } from 'vitest';
import { callModel, getModelRateLimiterSnapshot, type EngineEndpoint } from '@koala/agent-engine';
import { modelsRouter } from './models.js';
import { ModelService } from '../services/ModelService.js';
import { CredentialService } from '../../infrastructure/services/CredentialService.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { anyOf } from '../../platform/lib/test-matchers.js';
import { until } from '../../platform/testing/three-roles.js';
import { startModelStandIn } from '../testing/model-stand-in.js';

const KEY = 'models-traffic-key';
const asked: string[] = [];
const harness: Harness = await mountRouter({
  prefix: '/api/models',
  router: (db) => modelsRouter({
    db,
    modelService: new ModelService(db, { getAll: async () => [] } as never, {} as never, {} as never, {} as never, { read: async () => undefined }, KEY),
    credentialService: new CredentialService(db, KEY),
    rateLimits: (ownerId: string) => {
      asked.push(ownerId);
      return getModelRateLimiterSnapshot(ownerId);
    },
  }),
});

const answering = await startModelStandIn('fine ');
const holding = await startModelStandIn('later ', { holding: true });

afterAll(async () => {
  holding.release();
  await Promise.all([harness.close(), answering.close(), holding.close()]);
});

const ask = (baseUrl: string, endpoint: Pick<EngineEndpoint, 'rateLimitKey' | 'ownerId' | 'label'>) =>
  callModel({ endpoint: { baseUrl, ...endpoint }, messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 }, () => undefined);

describe('model traffic', () => {
  it('shows the person the traffic of their own models', async () => {
    for (let call = 0; call < 5; call += 1) await ask(answering.baseUrl, { rateLimitKey: 'tabby', ownerId: TEST_USER.id, label: 'Tabby' });
    await ask(answering.baseUrl, { rateLimitKey: 'theirs', ownerId: 'someone-else', label: 'Theirs' });
    const inFlight = ask(holding.baseUrl, { rateLimitKey: 'tabby', ownerId: TEST_USER.id, label: 'Tabby' });
    await until(async () => (holding.waiting() === 1 ? true : undefined));

    const res = await fetch(harness.url('/api/models/rate-limits'));

    expect(await res.json()).toEqual({ buckets: [{ key: 'tabby', label: 'Tabby', inFlight: 1, queued: 0, totalRequests: 5, total429: 0, totalErrors: 0, lastRequestAt: anyOf(String), lastStatus: 200 }] });
    expect(asked).toEqual([TEST_USER.id]);
    holding.release();
    await inFlight;
  });
});
