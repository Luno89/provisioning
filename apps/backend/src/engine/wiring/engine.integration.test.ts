import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, startThreeRoles, type ThreeRoles } from '../../platform/testing/three-roles.js';

let roles: ThreeRoles;
let session = '';

beforeAll(async () => {
  roles = await startThreeRoles('engine-wiring');
  session = await roles.ownerOnInstance();
});

afterAll(async () => {
  await roles?.close();
});

describe('the engine as an instance wires it, for its owner', () => {
  it('a memory the owner deletes while the memory index answers no one is kept, and they are told the index is down, since when and why', async () => {
    const at = roles.instance.url;
    const written = await call<{ id: string }>(`${at}/api/memories`, { method: 'POST', cookie: session, body: { category: 'environment_facts', scope: 'global', title: 'DNS lives at Cloudflare', text: 'The person manages DNS at Cloudflare.' } });
    expect(written.status, JSON.stringify(written.body)).toBe(201);

    const deleted = await call<{ error: string }>(`${at}/api/memories/${written.body.id}`, { method: 'DELETE', cookie: session });

    expect(deleted.status, JSON.stringify(deleted.body)).toBe(503);
    expect(deleted.body.error).toMatch(/^The memory index's (words \(Quickwit\)|meanings \(Qdrant\)) isn't answering since \d\d:\d\d UTC: /);
    expect((await call<{ id: string }[]>(`${at}/api/memories`, { cookie: session })).body.map((memory) => memory.id)).toContain(written.body.id);
  });

  it('an agent the owner saves is theirs, and one that names a tool that does not exist is refused, saying so', async () => {
    const at = roles.instance.url;
    const scout = { slug: 'scout', name: 'Scout', description: 'Looks around', version: '1', prompt: 'You look around.', guidance: '', returns: '', failures: [], procedure: 'tool-rounds', tools: [], environment: {} };

    const refused = await call<{ problems: string[] }>(`${at}/api/agents/scout`, { method: 'PUT', cookie: session, body: { ...scout, tools: ['ghost_tool'] } });
    const saved = await call<{ agent: { slug: string; mine: boolean } }>(`${at}/api/agents/scout`, { method: 'PUT', cookie: session, body: scout });

    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.problems.join(' ')).toContain('ghost_tool');
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.agent).toMatchObject({ slug: 'scout', mine: true });
  });
});
