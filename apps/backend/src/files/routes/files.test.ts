import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import { containing } from '../../platform/lib/test-matchers.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import { dispatch, SIGNED_IN } from '../../releases/testing/dispatch.js';
import { equalTo } from '../../releases/testing/equal-to.js';
import type { FileShare } from '../lib/file-shares.js';
import type { FileService } from '../services/FileService.js';
import { filesRouter, FILE_TYPE_HEADER, shareRouter, type FilesRouterDeps } from './files.js';

const project = { id: 'p1', name: 'Shop', ownerId: SIGNED_IN.id } as ProjectMetadata;
const inProject = equalTo({ kind: 'project' as const, project });
const mine = equalTo({ kind: 'mine' as const });

function setUp() {
  const files = mock<FileService>();
  const deps = mock<FilesRouterDeps>({ files });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  return { files, router: filesRouter(deps) };
}

const refused = (status: 400 | 404 | 409, why: string) => ({ ok: false as const, status, why });

describe('/api/files', () => {
  it('lists the person\'s file servers and sets or clears their default', async () => {
    const { files, router } = setUp();
    files.servers.calledWith(SIGNED_IN.id).mockResolvedValue({ servers: [{ kind: 'minio', deploymentId: 'm1', name: 'minio', clusterId: 'c1' }], defaultId: 'm1' });
    files.setDefault.calledWith(SIGNED_IN.id, 'm1').mockResolvedValue({ ok: true, value: { defaultId: 'm1' } });
    files.setDefault.calledWith(SIGNED_IN.id, null).mockResolvedValue({ ok: true, value: {} });
    files.setDefault.calledWith(SIGNED_IN.id, 'theirs').mockResolvedValue(refused(400, 'That is not one of your running file servers.'));
    expect((await dispatch(router, { method: 'GET', url: '/servers' })).json).toEqual({ servers: [{ kind: 'minio', deploymentId: 'm1', name: 'minio', clusterId: 'c1' }], defaultId: 'm1' });
    expect((await dispatch(router, { method: 'PUT', url: '/default', json: { deploymentId: 'm1' } })).json).toEqual({ defaultId: 'm1' });
    expect((await dispatch(router, { method: 'PUT', url: '/default', json: { deploymentId: null } })).json).toEqual({});
    const no = await dispatch(router, { method: 'PUT', url: '/default', json: { deploymentId: 'theirs' } });
    expect([no.status, no.json]).toEqual([400, { error: 'That is not one of your running file servers.' }]);
    expect((await dispatch(router, { method: 'PUT', url: '/default', json: { deploymentId: 7 } })).status).toBe(400);
  });

  it('lists the person\'s share links and revokes one', async () => {
    const { files, router } = setUp();
    const share = { id: 's1', ownerId: SIGNED_IN.id, path: 'a.pdf' } as FileShare;
    files.shares.calledWith(SIGNED_IN.id).mockResolvedValue([share]);
    files.unshare.calledWith(SIGNED_IN.id, 's1').mockResolvedValue({ ok: true, value: { id: 's1' } as never });
    files.unshare.calledWith(SIGNED_IN.id, 'nope').mockResolvedValue(refused(404, 'There is no such link.'));
    expect((await dispatch(router, { method: 'GET', url: '/shares' })).json).toEqual([share]);
    expect((await dispatch(router, { method: 'DELETE', url: '/shares/s1' })).status).toBe(200);
    expect((await dispatch(router, { method: 'DELETE', url: '/shares/nope' })).status).toBe(404);
  });

  it('says where a project\'s files go, and lets the person choose or start the server for it', async () => {
    const { files, router } = setUp();
    files.placeOf.calledWith(SIGNED_IN.id, inProject).mockResolvedValue({ state: 'none' });
    files.choose.calledWith(SIGNED_IN.id, project, 'm1').mockResolvedValue({ ok: true, value: { state: 'none' } });
    files.startMinio.calledWith(SIGNED_IN.id, project).mockResolvedValue({ ok: true, value: { state: 'none' } });
    expect((await dispatch(router, { method: 'GET', url: '/projects/p1/place' })).json).toEqual({ state: 'none' });
    expect((await dispatch(router, { method: 'PUT', url: '/projects/p1/place', json: { deploymentId: 'm1' } })).json).toEqual({ state: 'none' });
    expect((await dispatch(router, { method: 'PUT', url: '/projects/p1/place', json: {} })).status).toBe(400);
    expect((await dispatch(router, { method: 'POST', url: '/projects/p1/minio' })).status).toBe(202);
    for (const [method, url] of [['GET', '/projects/p2/place'], ['PUT', '/projects/p2/place'], ['POST', '/projects/p2/minio']] as const) {
      expect((await dispatch(router, { method, url, json: { deploymentId: 'm1' } })).status).toBe(404);
    }
  });

  it('lists a folder of a project or of the person\'s own files, refusing a path that leaves it', async () => {
    const { files, router } = setUp();
    const entries = [{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file' as const, size: 6 }];
    files.list.calledWith(SIGNED_IN.id, inProject, 'docs').mockResolvedValue({ ok: true, value: entries });
    files.list.calledWith(SIGNED_IN.id, mine, '').mockResolvedValue({ ok: true, value: [] });
    expect((await dispatch(router, { method: 'GET', url: '/projects/p1/list?dir=docs' })).json).toEqual(entries);
    expect((await dispatch(router, { method: 'GET', url: '/mine/list' })).json).toEqual([]);
    expect((await dispatch(router, { method: 'GET', url: '/projects/p1/list?dir=../..' })).status).toBe(400);
    expect((await dispatch(router, { method: 'GET', url: '/projects/p2/list' })).status).toBe(404);
    expect((await dispatch(router, { method: 'GET', url: '/everyone/list' })).json).toEqual({ error: 'Not found' });
  });

  it('says why a project\'s files cannot be listed yet', async () => {
    const { files, router } = setUp();
    files.list.mockResolvedValue(refused(409, 'This project has no file server yet.'));
    const none = await dispatch(router, { method: 'GET', url: '/projects/p1/list' });
    expect([none.status, none.json]).toEqual([409, { error: 'This project has no file server yet.' }]);
  });

  it('finds files by name, answering an empty search for a missing query', async () => {
    const { files, router } = setUp();
    files.search.calledWith(SIGNED_IN.id, inProject, 'brief').mockResolvedValue({ ok: true, value: [{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file' }] });
    files.search.calledWith(SIGNED_IN.id, inProject, '').mockResolvedValue({ ok: true, value: [] });
    expect((await dispatch(router, { method: 'GET', url: '/projects/p1/search?q=brief' })).json).toEqual([{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file' }]);
    expect((await dispatch(router, { method: 'GET', url: '/projects/p1/search' })).json).toEqual([]);
    expect((await dispatch(router, { method: 'GET', url: '/projects/p2/search?q=x' })).status).toBe(404);
  });

  it('makes a folder, taking its path from the query or the body', async () => {
    const { files, router } = setUp();
    files.makeFolder.calledWith(SIGNED_IN.id, inProject, 'empty').mockResolvedValue({ ok: true, value: { path: 'empty' } });
    const made = await dispatch(router, { method: 'POST', url: '/projects/p1/folder', json: { path: 'empty' } });
    expect([made.status, made.json]).toEqual([201, { path: 'empty' }]);
    expect((await dispatch(router, { method: 'POST', url: '/projects/p1/folder?path=empty' })).status).toBe(201);
    expect((await dispatch(router, { method: 'POST', url: '/projects/p1/folder', json: { path: '../x' } })).status).toBe(400);
    expect((await dispatch(router, { method: 'POST', url: '/projects/p2/folder', json: { path: 'empty' } })).status).toBe(404);
  });

  it('shares a file for a day, a week or a month only', async () => {
    const { files, router } = setUp();
    const share = { id: 's1', token: 't' } as FileShare;
    files.share.calledWith(SIGNED_IN.id, inProject, 'docs/brief.pdf', 7).mockResolvedValue({ ok: true, value: share });
    const made = await dispatch(router, { method: 'POST', url: '/projects/p1/shares', json: { path: 'docs/brief.pdf', days: 7 } });
    expect([made.status, made.json]).toEqual([201, share]);
    const three = await dispatch(router, { method: 'POST', url: '/projects/p1/shares', json: { path: 'docs/brief.pdf', days: 3 } });
    expect(three.status).toBe(400);
    expect(three.json).toEqual({ error: containing('days') });
    expect((await dispatch(router, { method: 'POST', url: '/projects/p2/shares', json: { path: 'a', days: 7 } })).status).toBe(404);
  });

  it('stores an upload byte for byte with the type it was sent as, and refuses a path outside the files', async () => {
    const { files, router } = setUp();
    const received: { bytes: Buffer; size: number | undefined; type: string }[] = [];
    files.upload.mockImplementation(async (_owner, _scope, path, body, size, type) => {
      const parts: Buffer[] = [];
      for await (const part of body) parts.push(Buffer.from(part as Buffer));
      received.push({ bytes: Buffer.concat(parts), size, type });
      return { ok: true, value: { path } };
    });
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const stored = await dispatch(router, { method: 'PUT', url: '/projects/p1/content?path=docs/brief.pdf', body: pdf, headers: { 'content-type': 'application/octet-stream', [FILE_TYPE_HEADER]: 'application/pdf' } });
    expect([stored.status, stored.json]).toEqual([201, { path: 'docs/brief.pdf' }]);
    expect(received).toEqual([{ bytes: pdf, size: 6, type: 'application/pdf' }]);
    await dispatch(router, { method: 'PUT', url: '/mine/content?path=a.bin', body: Buffer.from('a') });
    expect(received[1]?.type).toBe('application/octet-stream');
    expect((await dispatch(router, { method: 'PUT', url: '/projects/p1/content?path=../../x', body: Buffer.from('x') })).status).toBe(400);
    expect((await dispatch(router, { method: 'PUT', url: '/projects/p2/content?path=a', body: Buffer.from('x') })).status).toBe(404);
  });

  it('says a project with no file server cannot take an upload', async () => {
    const { files, router } = setUp();
    files.upload.mockResolvedValue(refused(409, 'This project has no file server yet.'));
    expect((await dispatch(router, { method: 'PUT', url: '/projects/p1/content?path=a.pdf', body: Buffer.from('x') })).status).toBe(409);
  });

  it('gives a file back as it was stored, as a download unless asked to show it', async () => {
    const { files, router } = setUp();
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    files.download.calledWith(SIGNED_IN.id, inProject, 'docs/brief.pdf').mockImplementation(async () => ({ ok: true, value: { stream: Readable.from([pdf]), size: pdf.length, contentType: 'application/pdf' } }));
    files.download.calledWith(SIGNED_IN.id, inProject, 'missing.pdf').mockResolvedValue(refused(404, 'There is no file missing.pdf.'));
    const back = await dispatch(router, { method: 'GET', url: '/projects/p1/content?path=docs/brief.pdf' });
    expect(back.bytes).toEqual(pdf);
    expect(back.headers['content-type']).toBe('application/pdf');
    expect(back.headers['content-disposition']).toBe("attachment; filename*=UTF-8''brief.pdf");
    expect(back.headers['content-length']).toBe('6');
    const shown = await dispatch(router, { method: 'GET', url: '/projects/p1/content?path=docs/brief.pdf&inline=1' });
    expect(shown.headers['content-disposition']).toBe("inline; filename*=UTF-8''brief.pdf");
    const gone = await dispatch(router, { method: 'GET', url: '/projects/p1/content?path=missing.pdf' });
    expect([gone.status, gone.json]).toEqual([404, { error: 'There is no file missing.pdf.' }]);
    expect((await dispatch(router, { method: 'GET', url: '/projects/p2/content?path=a' })).status).toBe(404);
  });

  it('serves a file of unknown size without a length', async () => {
    const { files, router } = setUp();
    files.download.mockImplementation(async () => ({ ok: true, value: { stream: Readable.from([Buffer.from('x')]), contentType: 'text/plain' } }));
    expect((await dispatch(router, { method: 'GET', url: '/mine/content?path=a.txt' })).headers['content-length']).toBeUndefined();
  });

  it('removes a file and moves one, refusing a path that leaves the files', async () => {
    const { files, router } = setUp();
    files.remove.calledWith(SIGNED_IN.id, inProject, 'old/a.txt').mockResolvedValue({ ok: true, value: { path: 'old/a.txt' } });
    files.move.calledWith(SIGNED_IN.id, inProject, 'a.txt', 'old/a.txt').mockResolvedValue({ ok: true, value: { path: 'old/a.txt' } });
    expect((await dispatch(router, { method: 'DELETE', url: '/projects/p1/content?path=old/a.txt' })).json).toEqual({ path: 'old/a.txt' });
    expect((await dispatch(router, { method: 'POST', url: '/projects/p1/move', json: { from: 'a.txt', to: 'old/a.txt' } })).json).toEqual({ path: 'old/a.txt' });
    expect((await dispatch(router, { method: 'POST', url: '/projects/p1/move', json: { from: '../a.txt', to: 'b' } })).status).toBe(400);
    expect((await dispatch(router, { method: 'POST', url: '/projects/p1/move', json: { from: 'a.txt', to: '../b' } })).status).toBe(400);
    expect((await dispatch(router, { method: 'DELETE', url: '/projects/p2/content?path=a' })).status).toBe(404);
    expect((await dispatch(router, { method: 'POST', url: '/projects/p2/move', json: { from: 'a', to: 'b' } })).status).toBe(404);
  });
});

describe('/api/share', () => {
  const served = (contentType: string, name: string, bytes: Buffer, size?: number) => ({ ok: true as const, value: { stream: Readable.from([bytes]), contentType, name, size } });

  it('opens a shared file signed out, inline, with the policy its type allows', async () => {
    const files = mock<Pick<FileService, 'shared'>>();
    const router = shareRouter({ files });
    files.shared.calledWith('good').mockImplementation(async () => served('application/pdf', 'brief.pdf', Buffer.from('%PDF'), 4));
    files.shared.calledWith('page').mockImplementation(async () => served('text/html', 'page.html', Buffer.from('<script>alert(1)</script>')));
    const opened = await dispatch(router, { method: 'GET', url: '/good' });
    expect(opened.bytes.toString()).toBe('%PDF');
    expect(opened.headers['content-disposition']).toBe("inline; filename*=UTF-8''brief.pdf");
    expect(opened.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(opened.headers['content-length']).toBe('4');
    const page = await dispatch(router, { method: 'GET', url: '/page' });
    expect(String(page.headers['content-security-policy'])).toContain('sandbox');
    expect(page.headers['content-length']).toBeUndefined();
    const download = await dispatch(router, { method: 'GET', url: '/good?download=1' });
    expect(download.headers['content-disposition']).toBe("attachment; filename*=UTF-8''brief.pdf");
  });

  it('answers a link that is revoked, expired or unknown in plain text', async () => {
    const files = mock<Pick<FileService, 'shared'>>();
    files.shared.mockResolvedValue(refused(404, 'This link has expired or was revoked.'));
    const gone = await dispatch(shareRouter({ files }), { method: 'GET', url: '/old' });
    expect([gone.status, gone.headers['content-type'], gone.text]).toEqual([404, 'text/plain; charset=utf-8', 'This link has expired or was revoked.']);
  });
});
