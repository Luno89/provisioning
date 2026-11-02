import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from '../../platform/routes/test-harness.js';
import { clientImportRouter } from './client-import.js';

const quiet = { validateStatus: () => true };

function harness() {
  const got: { owner: string; project: string; mode: unknown; bytes: number; size: number }[] = [];
  const imports: { view: unknown; upload: unknown; startFresh?: unknown } & Record<string, unknown> = {
    view: async (ownerId: string, projectId: string) => ({ ok: true as const, value: { open: true, ownerId, projectId } as never }),
    upload: async (owner: string, project: string, input: { mode: unknown; bytes: number; body: NodeJS.ReadableStream }) => {
      let size = 0;
      for await (const chunk of input.body) size += (chunk as Buffer).length;
      got.push({ owner, project, mode: input.mode, bytes: input.bytes, size });
      return input.mode === 'live' ? { ok: false as const, status: 409 as const, error: 'the backup is from Odoo 17.0' } : { ok: true as const, value: { state: 'uploaded', mode: 'copy', bytes: size, at: 'now' } as never };
    },
  };
  imports.startFresh = async (_owner: string, project: string) => (project === 'p1' ? { ok: true as const, value: { released: true } } : { ok: false as const, status: 409 as const, error: 'not waiting' });
  const getOwnedProject = async (id: string, user: { id: string }) => (id === 'p1' ? { id, ownerId: user.id } as never : undefined);
  return { got, mounted: mountRouter({ prefix: '/api/projects', router: () => clientImportRouter({ imports: imports as never, getOwnedProject }) }) };
}

describe('a client\'s database for a project', () => {
  it('streams the whole upload to the service with its size and mode, as the project\'s owner', async () => {
    const { got, mounted } = harness();
    const h = await mounted;
    const zip = Buffer.alloc(3 * 1024 * 1024, 7);
    const put = await axios.put(h.url('/api/projects/p1/import?mode=copy'), zip, { headers: { 'Content-Type': 'application/zip' }, maxBodyLength: Infinity, ...quiet });
    expect(put.status).toBe(201);
    expect(got).toEqual([{ owner: TEST_USER.id, project: 'p1', mode: 'copy', bytes: zip.length, size: zip.length }]);
    const refused = await axios.put(h.url('/api/projects/p1/import?mode=live'), Buffer.from('PK'), { headers: { 'Content-Type': 'application/zip' }, ...quiet });
    expect([refused.status, refused.data]).toEqual([409, { error: 'the backup is from Odoo 17.0' }]);
    expect((await axios.put(h.url('/api/projects/p2/import'), Buffer.from('PK'), { headers: { 'Content-Type': 'application/zip' }, ...quiet })).status).toBe(404);
    expect((await axios.get(h.url('/api/projects/p1/import'))).data).toEqual({ open: true, ownerId: TEST_USER.id, projectId: 'p1' });
    expect((await axios.delete(h.url('/api/projects/p1/import'))).data).toEqual({ released: true });
    await h.close();
  });
});
