import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { ClientImport } from '../lib/client-import.js';
import { dispatch, SIGNED_IN } from '../testing/dispatch.js';
import { clientImportRouter, type ClientImportRouterDeps } from './client-import.js';

const project = { id: 'p1', name: 'Shop', ownerId: SIGNED_IN.id } as ProjectMetadata;
const uploaded: ClientImport = { state: 'uploaded', mode: 'copy', bytes: 10, at: 't' };

function setUp() {
  const imports = mock<ClientImportRouterDeps['imports']>();
  const deps = mock<ClientImportRouterDeps>({ imports });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  return { imports, router: clientImportRouter(deps) };
}

describe('a client\'s database for a project', () => {
  it('says whether the project can still start from one, and nothing of a project the person does not own', async () => {
    const { imports, router } = setUp();
    imports.view.calledWith(SIGNED_IN.id, 'p1').mockResolvedValue({ ok: true, value: { open: true } });
    expect((await dispatch(router, { method: 'GET', url: '/p1/import' })).json).toEqual({ open: true });
    const other = await dispatch(router, { method: 'GET', url: '/p2/import' });
    expect([other.status, other.json]).toEqual([404, { error: 'You have no project with that id' }]);
  });

  it('hands the whole upload to the service with its size and mode, as the project\'s owner', async () => {
    const { imports, router } = setUp();
    const read: { mode: unknown; bytes: number; size: number }[] = [];
    imports.upload.mockImplementation(async (_owner, _project, input) => {
      let size = 0;
      for await (const chunk of input.body) size += (chunk as Buffer).length;
      read.push({ mode: input.mode, bytes: input.bytes, size });
      return { ok: true, value: uploaded };
    });
    const zip = Buffer.alloc(3 * 1024 * 1024, 7);
    const put = await dispatch(router, { method: 'PUT', url: '/p1/import?mode=live', body: zip, headers: { 'content-type': 'application/zip' } });
    expect([put.status, put.json]).toEqual([201, uploaded]);
    expect(read).toEqual([{ mode: 'live', bytes: zip.length, size: zip.length }]);
    expect(imports.upload).toHaveBeenCalledWith(SIGNED_IN.id, 'p1', any());
  });

  it('takes an upload as a copy when no mode is given', async () => {
    const { imports, router } = setUp();
    imports.upload.mockResolvedValue({ ok: true, value: uploaded });
    await dispatch(router, { method: 'PUT', url: '/p1/import', body: Buffer.from('PK') });
    expect(imports.upload.mock.calls[0]?.[2].mode).toBe('copy');
  });

  it('says why the service refused an upload', async () => {
    const { imports, router } = setUp();
    imports.upload.mockResolvedValue({ ok: false, status: 409, error: 'the backup is from Odoo 17.0' });
    const refused = await dispatch(router, { method: 'PUT', url: '/p1/import?mode=live', body: Buffer.from('PK') });
    expect([refused.status, refused.json]).toEqual([409, { error: 'the backup is from Odoo 17.0' }]);
  });

  it('refuses an upload for a project the person does not own without sending it to the service', async () => {
    const { imports, router } = setUp();
    const refused = await dispatch(router, { method: 'PUT', url: '/p2/import', body: Buffer.from('PK') });
    expect(refused.status).toBe(404);
    expect(imports.upload).not.toHaveBeenCalled();
  });

  it('starts the project without the client\'s database', async () => {
    const { imports, router } = setUp();
    imports.startFresh.calledWith(SIGNED_IN.id, 'p1').mockResolvedValue({ ok: true, value: { released: true } });
    expect((await dispatch(router, { method: 'DELETE', url: '/p1/import' })).json).toEqual({ released: true });
    expect((await dispatch(router, { method: 'DELETE', url: '/p2/import' })).status).toBe(404);
  });
});
