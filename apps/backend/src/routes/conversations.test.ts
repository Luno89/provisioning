import { describe, it, expect, afterAll } from 'vitest';
import { conversationsRouter } from './conversations.js';
import { mountRouter, type Harness } from './test-harness.js';
import type { Database } from '../lib/db-interface.js';

const harness: Harness = await mountRouter({
  prefix: '/api/conversations',
  router: (db: Database) => conversationsRouter({
    db,
    ownedConversations: async (userId: string) =>
      db.getConversations().then((c: any) => c.filter((x: any) => x.ownerId === userId)),
  }),
});

afterAll(async () => { await harness.close(); });

describe('conversation CRUD', () => {
  it('creates, lists, reads, and deletes a conversation', async () => {
    const createRes = await fetch(harness.url('/api/conversations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'My Custom Thread' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string };
    expect(created.id).toBeDefined();

    const listRes = await fetch(harness.url('/api/conversations'));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any[];
    expect(list.some((c: any) => c.id === created.id)).toBe(true);

    const getRes = await fetch(harness.url(`/api/conversations/${created.id}`));
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { id: string };
    expect(got.id).toBe(created.id);

    const delRes = await fetch(harness.url(`/api/conversations/${created.id}`), { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const afterDel = (await harness.db.getConversations()).find((c: any) => c.id === created.id);
    expect(afterDel).toBeUndefined();
  });
});

describe('proposal accept/dismiss', () => {
  it('accepts project tree and app spec proposals', async () => {
    const convId = 'proposal-test-conv';
    const now = new Date().toISOString();
    await harness.db.saveConversation({
      id: convId,
      ownerId: 'test-user',
      title: 'Proposal Conv',
      messages: [],
      proposedTrees: [{ id: 'prop-tree-1', name: 'New Project', type: 'web', goal: 'Build web app', proposedAt: now }],
      proposedSpecs: [{
        id: 'my-custom-app',
        proposedAt: now,
        spec: {
          id: 'my-custom-app',
          image: 'nginx:alpine',
          ports: [{ name: 'http', port: 80 }],
          resources: { limits: { memory: '512Mi', cpu: '500m' } },
        },
      }],
      createdAt: now,
      updatedAt: now,
    });

    const treeRes = await fetch(harness.url(`/api/conversations/${convId}/trees/prop-tree-1/accept`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { tree?: { id: string } };
    expect(treeBody.tree?.id).toBeDefined();

    const specRes = await fetch(harness.url(`/api/conversations/${convId}/specs/my-custom-app/accept`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(specRes.status).toBe(200);
    const specBody = (await specRes.json()) as { id: string };
    expect(specBody.id).toBe('my-custom-app');
  });

  it('appends a "here\'s what happened" notice to the transcript on every proposal action', async () => {
    const convId = 'notice-test-conv';
    const now = new Date().toISOString();
    await harness.db.saveConversation({
      id: convId, ownerId: 'test-user', title: 'Notice Conv', messages: [],
      proposedTrees: [{ id: 't1', name: 'Tree A', type: 'web', goal: 'x', proposedAt: now }],
      proposedEscalations: [{ id: 'e1', reason: 'r', scope: 'cluster-read', proposedAt: now, status: 'pending' }],
      proposedSecretRequests: [{ id: 's1', key: 'FOO', description: 'd', status: 'pending', requestedAt: now }],
      createdAt: now, updatedAt: now,
    });

    await fetch(harness.url(`/api/conversations/${convId}/trees/t1/accept`), { method: 'POST' });
    await fetch(harness.url(`/api/conversations/${convId}/escalations/e1/deny`), { method: 'POST' });
    await fetch(harness.url(`/api/conversations/${convId}/secrets/s1/dismiss`), { method: 'POST' });

    const conv = (await harness.db.getConversations()).find((c: any) => c.id === convId);
    const notices = (conv?.messages ?? []).filter((m: any) => m.notice);
    expect(notices).toHaveLength(3);
    expect(notices[0]?.content).toMatch(/Accepted the "Tree A" tree/);
    expect(notices[1]?.content).toMatch(/Denied the privilege escalation/);
    expect(notices[2]?.content).toMatch(/Dismissed the request for FOO/);
  });

  it('dismisses a pending tree or spec proposal, refusing a second dismiss or one already accepted', async () => {
    const convId = 'dismiss-test-conv';
    const now = new Date().toISOString();
    await harness.db.saveConversation({
      id: convId, ownerId: 'test-user', title: 'Dismiss Conv', messages: [],
      proposedTrees: [
        { id: 'dt1', name: 'Dismiss Me', type: 'web', goal: 'x', proposedAt: now },
        { id: 'dt2', name: 'Already Gone', type: 'web', goal: 'x', proposedAt: now },
      ],
      proposedSpecs: [{ id: 'dismiss-spec', proposedAt: now, spec: { id: 'dismiss-spec', image: 'x', ports: [] } }],
      createdAt: now, updatedAt: now,
    });

    const treeRes = await fetch(harness.url(`/api/conversations/${convId}/trees/dt1/dismiss`), { method: 'POST' });
    expect(treeRes.status).toBe(200);
    const specRes = await fetch(harness.url(`/api/conversations/${convId}/specs/dismiss-spec/dismiss`), { method: 'POST' });
    expect(specRes.status).toBe(200);

    const again = await fetch(harness.url(`/api/conversations/${convId}/trees/dt1/dismiss`), { method: 'POST' });
    expect(again.status).toBe(409);

    const unknown = await fetch(harness.url(`/api/conversations/${convId}/trees/no-such-id/dismiss`), { method: 'POST' });
    expect(unknown.status).toBe(404);

    const conv = (await harness.db.getConversations()).find((c: any) => c.id === convId);
    expect(conv?.proposedTrees?.find((t: any) => t.id === 'dt1')?.dismissedAt).toBeDefined();
    expect(conv?.proposedSpecs?.find((s: any) => s.id === 'dismiss-spec')?.dismissedAt).toBeDefined();
  });
});
