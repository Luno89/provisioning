import { describe, it, expect, afterEach, vi } from 'vitest';
import axios from 'axios';
import { customStepsRouter } from './custom-steps.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; vi.restoreAllMocks(); });

describe('custom step definitions', () => {
  it('creates one via POST and lists it back', async () => {
    h = await mountRouter({ prefix: '/api/custom-steps', router: (db) => customStepsRouter({ db }) });

    const create = await axios.post(h.url('/api/custom-steps'), {
      id: 'lighthouse', name: 'Lighthouse score', command: 'lighthouse {{url}}',
      fields: [{ key: 'url', label: 'URL', kind: 'string' }],
    });
    expect(create.status).toBe(201);
    expect(create.data.ownerId).toBe(TEST_USER.id);

    const list = await axios.get(h.url('/api/custom-steps'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe('Lighthouse score');
  });

  it('refuses an invalid definition', async () => {
    h = await mountRouter({ prefix: '/api/custom-steps', router: (db) => customStepsRouter({ db }) });
    await expect(axios.post(h.url('/api/custom-steps'), { id: 'x' })).rejects.toMatchObject({
      response: { status: 400 },
    });
  });

  it('updates an existing definition via PUT, keeping its createdAt', async () => {
    h = await mountRouter({ prefix: '/api/custom-steps', router: (db) => customStepsRouter({ db }) });
    const created = await axios.post(h.url('/api/custom-steps'), {
      id: 'lighthouse', name: 'Lighthouse', command: 'lighthouse {{url}}', fields: [],
    });

    const updated = await axios.put(h.url('/api/custom-steps/lighthouse'), {
      name: 'Lighthouse (updated)', command: 'lighthouse {{url}}', fields: [],
    });
    expect(updated.data.name).toBe('Lighthouse (updated)');
    expect(updated.data.createdAt).toBe(created.data.createdAt);
  });

  it('deletes a definition nothing references', async () => {
    h = await mountRouter({ prefix: '/api/custom-steps', router: (db) => customStepsRouter({ db }) });
    await axios.post(h.url('/api/custom-steps'), { id: 'lighthouse', name: 'Lighthouse', command: 'x', fields: [] });

    const del = await axios.delete(h.url('/api/custom-steps/lighthouse'));
    expect(del.data).toEqual({ deleted: 'lighthouse' });
    expect((await axios.get(h.url('/api/custom-steps'))).data).toHaveLength(0);
  });

  it('refuses to delete a definition a tree type still references', async () => {
    h = await mountRouter({ prefix: '/api/custom-steps', router: (db) => customStepsRouter({ db }) });
    await axios.post(h.url('/api/custom-steps'), { id: 'lighthouse', name: 'Lighthouse', command: 'x', fields: [] });
    await h.db.saveTreeType({
      id: 'my-type', ownerId: TEST_USER.id, label: 'My type', summary: 's', language: 'node',
      produces: 'service', doneMeans: 'd', files: [],
      validationRecipe: { type: 'command', checks: [{ id: 'c1', name: 'Check', type: 'custom', customStepId: 'lighthouse' }] },
    });

    await expect(axios.delete(h.url('/api/custom-steps/lighthouse'))).rejects.toMatchObject({
      response: { status: 409 },
    });
  });

  it('refuses an unauthenticated caller', async () => {
    h = await mountRouter({ prefix: '/api/custom-steps', user: null, router: (db) => customStepsRouter({ db }) });
    await expect(axios.get(h.url('/api/custom-steps'))).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});
