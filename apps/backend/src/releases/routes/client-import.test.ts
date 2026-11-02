import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { ClientImport } from '../lib/client-import.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { clientImportRouter, type ClientImportRouterDeps } from './client-import.js';

const project = { id: 'p1', name: 'Shop', ownerId: TEST_USER.id } as ProjectMetadata;
const uploaded: ClientImport = { state: 'uploaded', mode: 'copy', bytes: 10, at: 't' };

async function setUp() {
  const imports = mock<ClientImportRouterDeps['imports']>();
  const deps = mock<ClientImportRouterDeps>({ imports });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  const routes = await routesInProcess({ prefix: '/', router: () => clientImportRouter(deps) });
  return { imports, routes };
}

describe('a client\'s database for a project', () => {
  it('says whether the project can still start from one, and nothing of a project the person does not own', async () => {
    const { imports, routes } = await setUp();
    imports.view.calledWith(TEST_USER.id, 'p1').mockResolvedValue({ ok: true, value: { open: true } });
    expect((await routes.get('/p1/import')).data).toEqual({ open: true });
    const other = await routes.get('/p2/import');
    expect([other.status, other.data]).toEqual([404, { error: 'You have no project with that id' }]);
  });

  it('hands the whole upload to the service with its size and mode, as the project\'s owner', async () => {
    const { imports, routes } = await setUp();
    const read: { mode: unknown; bytes: number; size: number }[] = [];
    imports.upload.mockImplementation(async (_owner, _project, input) => {
      let size = 0;
      for await (const chunk of input.body) size += (chunk as Buffer).length;
      read.push({ mode: input.mode, bytes: input.bytes, size });
      return { ok: true, value: uploaded };
    });
    const zip = Buffer.alloc(3 * 1024 * 1024, 7);
    const put = await routes.put('/p1/import?mode=live', undefined, { raw: zip, headers: { 'content-type': 'application/zip' } });
    expect([put.status, put.data]).toEqual([201, uploaded]);
    expect(read).toEqual([{ mode: 'live', bytes: zip.length, size: zip.length }]);
    expect(imports.upload).toHaveBeenCalledWith(TEST_USER.id, 'p1', any());
  });

  it('takes an upload as a copy when no mode is given', async () => {
    const { imports, routes } = await setUp();
    imports.upload.mockResolvedValue({ ok: true, value: uploaded });
    await routes.put('/p1/import', undefined, { raw: Buffer.from('PK') });
    expect(imports.upload.mock.calls[0]?.[2].mode).toBe('copy');
  });

  it('says why the service refused an upload', async () => {
    const { imports, routes } = await setUp();
    imports.upload.mockResolvedValue({ ok: false, status: 409, error: 'the backup is from Odoo 17.0' });
    const refused = await routes.put('/p1/import?mode=live', undefined, { raw: Buffer.from('PK') });
    expect([refused.status, refused.data]).toEqual([409, { error: 'the backup is from Odoo 17.0' }]);
  });

  it('refuses an upload for a project the person does not own without sending it to the service', async () => {
    const { imports, routes } = await setUp();
    const refused = await routes.put('/p2/import', undefined, { raw: Buffer.from('PK') });
    expect(refused.status).toBe(404);
    expect(imports.upload).not.toHaveBeenCalled();
  });

  it('starts the project without the client\'s database', async () => {
    const { imports, routes } = await setUp();
    imports.startFresh.calledWith(TEST_USER.id, 'p1').mockResolvedValue({ ok: true, value: { released: true } });
    expect((await routes.delete('/p1/import')).data).toEqual({ released: true });
    expect((await routes.delete('/p2/import')).status).toBe(404);
  });
});
