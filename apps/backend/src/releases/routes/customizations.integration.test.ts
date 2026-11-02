import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { customizationItems, customizationsOver } from '../testing/customizations-behaviour.js';
import { customizationsRouter } from './customizations.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const quiet = { validateStatus: () => true };

async function mount(world: Parameters<typeof customizationsOver>[1] = {}, channel: string | null = 'channel-p1') {
  let placed: Awaited<ReturnType<typeof customizationsOver>> | undefined;
  h = await mountRouter({
    prefix: '/api/projects',
    router: async (db) => {
      placed = await customizationsOver(db, { owner: TEST_USER.id, ...world });
      return customizationsRouter({
        customizations: placed.service,
        channelOf: async () => channel ?? undefined,
        getOwnedProject: async (id, principal) => (await db.projects.getProjects()).find((project) => project.id === id && project.ownerId === principal.id),
      });
    },
  });
  return { harness: h, placed: placed! };
}

describe('what was made in a project\'s live app, over HTTP', () => {
  it('lists it for a project the person owns, and says so for one they do not', async () => {
    const { harness } = await mount();
    const listed = await axios.get(harness.url('/api/projects/p1/customizations'));
    expect(listed.data).toEqual({ projectId: 'p1', project: 'Shop', module: 'shop_customizations', items: customizationItems });
    const other = await axios.get(harness.url('/api/projects/p2/customizations'), quiet);
    expect([other.status, other.data]).toEqual([404, { error: 'You have no project with that id' }]);
  });

  it('lists nothing while nothing is live', async () => {
    const { harness } = await mount({ live: false });
    expect((await axios.get(harness.url('/api/projects/p1/customizations'))).data).toMatchObject({ items: [] });
  });

  it('proposes bringing it into git on the project\'s channel, stored for the person, and answers with the proposal', async () => {
    const { harness, placed } = await mount();
    const proposed = await axios.post(harness.url('/api/projects/p1/customizations/adopt'), { why: 'keep what the client made' }, quiet);
    expect(proposed.status).toBe(201);
    expect(proposed.data).toMatchObject({ id: 'card-1', ownerId: TEST_USER.id, projectId: 'p1', status: 'proposed', conversationId: 'channel-p1' });
    expect(await placed.saved()).toHaveLength(1);
  });

  it('proposes without a conversation when the project has no channel, and passes the service\'s refusal on', async () => {
    const { harness, placed } = await mount({}, null);
    const refused = await axios.post(harness.url('/api/projects/p1/customizations/adopt'), {}, quiet);
    expect([refused.status, refused.data]).toEqual([400, { error: 'say why, for the card' }]);
    const proposed = await axios.post(harness.url('/api/projects/p1/customizations/adopt'), { why: 'w' }, quiet);
    expect(proposed.status).toBe(201);
    expect((await placed.saved())[0]?.conversationId).toBeUndefined();
    expect((await axios.post(harness.url('/api/projects/p2/customizations/adopt'), { why: 'w' }, quiet)).status).toBe(404);
  });
});
