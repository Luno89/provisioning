import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from './test-harness.js';
import { modelsRouter } from './models.js';

const quiet = { validateStatus: () => true };

describe('the account default', () => {
  it('takes an agent on one of the person\'s machines, and refuses one that cannot answer', async () => {
    const asked: string[] = [];
    const h = await mountRouter({
      prefix: '/api/models',
      router: async (db) => {
        await db.saveUser({ id: TEST_USER.id, email: TEST_USER.email } as never);
        return modelsRouter({
          db,
          modelService: { list: async () => [{ id: 'tabby-qwen' }] },
          machines: {
            choiceProblem: async (ownerId: string, choice: { deviceId: string; agent: string }) => {
              asked.push(`${ownerId}:${choice.deviceId}:${choice.agent}`);
              return choice.deviceId === 'gone' ? 'that machine is not one of yours any more' : undefined;
            },
          },
        });
      },
    });

    const set = await axios.put(h.url('/api/models/default'), { modelId: 'machine:d1:claude-code' }, quiet);
    expect([set.status, set.data.defaultModelId]).toEqual([200, 'machine:d1:claude-code']);
    expect((await axios.get(h.url('/api/models/default'))).data.defaultModelId).toBe('machine:d1:claude-code');

    const gone = await axios.put(h.url('/api/models/default'), { modelId: 'machine:gone:claude-code' }, quiet);
    expect([gone.status, gone.data.error]).toEqual([400, 'that machine is not one of yours any more']);
    expect((await axios.get(h.url('/api/models/default'))).data.defaultModelId).toBe('machine:d1:claude-code');

    expect((await axios.put(h.url('/api/models/default'), { modelId: 'nothing' }, quiet)).status).toBe(404);
    expect((await axios.put(h.url('/api/models/default'), { modelId: 'tabby-qwen' }, quiet)).status).toBe(200);
    expect(asked).toEqual([`${TEST_USER.id}:d1:claude-code`, `${TEST_USER.id}:gone:claude-code`]);
    await h.close();
  });
});
