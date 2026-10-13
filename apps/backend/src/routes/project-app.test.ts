import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import { mountRouter, type Harness } from './test-harness.js';
import { projectAppRouter } from './project-app.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const mount = async () => {
  const opened: string[] = [];
  h = await mountRouter({
    prefix: '/api/projects',
    router: () => projectAppRouter({
      apps: {
        app: async () => ({ id: 'd1', name: 'Shop', status: 'running', local: {}, public: {} }),
        open: async (_project, mode) => { opened.push(mode); return { id: 'd1', name: 'Shop', status: 'running', local: { app: 'http://shop.localhost:8000' }, public: {} }; },
      },
      getOwnedProject: async (id) => (id === 'p1' ? { id, name: 'Shop' } as never : undefined),
    }),
  });
  return { harness: h, opened };
};

describe('a project\'s app', () => {
  it('says where it is, and opens it on this machine or publicly as asked', async () => {
    const { harness, opened } = await mount();
    expect((await axios.get(harness.url('/api/projects/p1/app'))).data).toEqual({ app: { id: 'd1', name: 'Shop', status: 'running', local: {}, public: {} } });
    expect((await axios.post(harness.url('/api/projects/p1/app/open'), { mode: 'local' })).data.app.local.app).toBe('http://shop.localhost:8000');
    await axios.post(harness.url('/api/projects/p1/app/open'), { mode: 'public' });
    expect(opened).toEqual(['local', 'public']);
  });

  it('refuses a mode it does not know, and a project the person does not own', async () => {
    const { harness, opened } = await mount();
    expect((await axios.post(harness.url('/api/projects/p1/app/open'), { mode: 'everywhere' }, { validateStatus: () => true })).status).toBe(400);
    expect((await axios.post(harness.url('/api/projects/p2/app/open'), { mode: 'local' }, { validateStatus: () => true })).status).toBe(404);
    expect(opened).toEqual([]);
  });
});
