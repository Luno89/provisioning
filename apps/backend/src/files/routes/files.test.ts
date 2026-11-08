import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import { containing } from '../../platform/lib/test-matchers.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { equalTo } from '../../platform/testing/matchers.js';
import { DROP_TYPE, dropBody } from '../lib/drops.js';
import type { FileShare } from '../lib/file-shares.js';
import type { FileService } from '../services/FileService.js';
import { filesRouter, FILE_TYPE_HEADER, shareRouter, type FilesRouterDeps } from './files.js';

const project = { id: 'p1', name: 'Shop', ownerId: TEST_USER.id } as ProjectMetadata;
const inProject = equalTo({ kind: 'project' as const, project });
const mine = equalTo({ kind: 'person' as const });
const inChat = equalTo({ kind: 'conversation' as const, conversationId: 'c1' });
const inChannel = equalTo({ kind: 'conversation' as const, conversationId: 'channel-p1', projectId: 'p1' });

async function setUp() {
  const files = mock<FileService>();
  const deps = mock<FilesRouterDeps>({ files });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  deps.getOwnedConversation.calledWith(TEST_USER.id, 'c1').mockResolvedValue({ id: 'c1' });
  deps.getOwnedConversation.calledWith(TEST_USER.id, 'channel-p1').mockResolvedValue({ id: 'channel-p1', projectId: 'p1' });
  deps.getOwnedConversation.calledWith(TEST_USER.id, 'theirs').mockResolvedValue(undefined);
  const routes = await routesInProcess({ prefix: '/', router: () => filesRouter(deps) });
  return { files, routes };
}

const refused = (status: 400 | 404 | 409 | 507, why: string) => ({ ok: false as const, status, why });

describe('/api/files', () => {
  it('lists the person\'s share links and revokes one', async () => {
    const { files, routes } = await setUp();
    const share = { id: 's1', ownerId: TEST_USER.id, path: 'a.pdf' } as FileShare;
    files.shares.calledWith(TEST_USER.id).mockResolvedValue([share]);
    files.unshare.calledWith(TEST_USER.id, 's1').mockResolvedValue({ ok: true, value: { id: 's1' } as never });
    files.unshare.calledWith(TEST_USER.id, 'nope').mockResolvedValue(refused(404, 'There is no such link.'));
    expect((await routes.get('/shares')).data).toEqual([share]);
    expect((await routes.delete('/shares/s1')).status).toBe(200);
    expect((await routes.delete('/shares/nope')).status).toBe(404);
  });

  it('lists a folder of a project or of the person\'s own files, refusing a path that leaves it', async () => {
    const { files, routes } = await setUp();
    const entries = [{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file' as const, size: 6 }];
    files.list.calledWith(TEST_USER.id, inProject, 'docs').mockResolvedValue({ ok: true, value: entries });
    files.list.calledWith(TEST_USER.id, mine, '').mockResolvedValue({ ok: true, value: [] });
    expect((await routes.get('/projects/p1/list?dir=docs')).data).toEqual(entries);
    expect((await routes.get('/mine/list')).data).toEqual([]);
    expect((await routes.get('/projects/p1/list?dir=../..')).status).toBe(400);
    expect((await routes.get('/projects/p2/list')).status).toBe(404);
    expect((await routes.get('/everyone/list')).data).toEqual({ error: 'Not found' });
  });

  it('lists a chat\'s files, in its project when it belongs to one, and only for the chat\'s owner', async () => {
    const { files, routes } = await setUp();
    files.list.calledWith(TEST_USER.id, inChat, '').mockResolvedValue({ ok: true, value: [{ name: 'a.png', path: 'a.png', type: 'file' }] });
    files.list.calledWith(TEST_USER.id, inChannel, '').mockResolvedValue({ ok: true, value: [] });
    expect((await routes.get('/conversations/c1/list')).data).toEqual([{ name: 'a.png', path: 'a.png', type: 'file' }]);
    expect((await routes.get('/conversations/channel-p1/list')).data).toEqual([]);
    const theirs = await routes.get('/conversations/theirs/list');
    expect([theirs.status, theirs.data]).toEqual([404, { error: 'Conversation not found' }]);
    expect((await routes.put('/conversations/theirs/content?path=a', undefined, { raw: Buffer.from('x') })).status).toBe(404);
  });

  it('says why a folder cannot be listed', async () => {
    const { files, routes } = await setUp();
    files.list.mockResolvedValue(refused(404, 'docs is not a folder here'));
    const none = await routes.get('/projects/p1/list?dir=docs');
    expect([none.status, none.data]).toEqual([404, { error: 'docs is not a folder here' }]);
  });

  it('finds files by name, answering an empty search for a missing query', async () => {
    const { files, routes } = await setUp();
    files.search.calledWith(TEST_USER.id, inProject, 'brief').mockResolvedValue({ ok: true, value: [{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file' }] });
    files.search.calledWith(TEST_USER.id, inProject, '').mockResolvedValue({ ok: true, value: [] });
    expect((await routes.get('/projects/p1/search?q=brief')).data).toEqual([{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file' }]);
    expect((await routes.get('/projects/p1/search')).data).toEqual([]);
    expect((await routes.get('/projects/p2/search?q=x')).status).toBe(404);
  });

  it('makes a folder, taking its path from the query or the body', async () => {
    const { files, routes } = await setUp();
    files.makeFolder.calledWith(TEST_USER.id, inProject, 'empty').mockResolvedValue({ ok: true, value: { path: 'empty' } });
    const made = await routes.post('/projects/p1/folder', { path: 'empty' });
    expect([made.status, made.data]).toEqual([201, { path: 'empty' }]);
    expect((await routes.post('/projects/p1/folder?path=empty')).status).toBe(201);
    expect((await routes.post('/projects/p1/folder', { path: '../x' })).status).toBe(400);
    expect((await routes.post('/projects/p2/folder', { path: 'empty' })).status).toBe(404);
  });

  it('shares a file for a day, a week or a month only', async () => {
    const { files, routes } = await setUp();
    const share = { id: 's1', token: 't' } as FileShare;
    files.share.calledWith(TEST_USER.id, inProject, 'docs/brief.pdf', 7).mockResolvedValue({ ok: true, value: share });
    const made = await routes.post('/projects/p1/shares', { path: 'docs/brief.pdf', days: 7 });
    expect([made.status, made.data]).toEqual([201, share]);
    const three = await routes.post('/projects/p1/shares', { path: 'docs/brief.pdf', days: 3 });
    expect(three.status).toBe(400);
    expect(three.data).toEqual({ error: containing('days') });
    expect((await routes.post('/projects/p2/shares', { path: 'a', days: 7 })).status).toBe(404);
  });

  it('stores an upload byte for byte with the type it was sent as, and refuses a path outside the files', async () => {
    const { files, routes } = await setUp();
    const received: { bytes: Buffer; size: number | undefined; type: string }[] = [];
    const replacing: boolean[] = [];
    files.upload.mockImplementation(async (_owner, _scope, path, body, size, type, options) => {
      const parts: Buffer[] = [];
      for await (const part of body) parts.push(Buffer.from(part as Buffer));
      received.push({ bytes: Buffer.concat(parts), size, type });
      replacing.push(options.replace);
      return { ok: true, value: { path, id: `id-${received.length}` } };
    });
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const stored = await routes.put('/projects/p1/content?path=docs/brief.pdf', undefined, { raw: pdf, headers: { 'content-type': 'application/octet-stream', [FILE_TYPE_HEADER]: 'application/pdf' } });
    expect([stored.status, stored.data]).toEqual([201, { path: 'docs/brief.pdf', id: 'id-1' }]);
    expect(received).toEqual([{ bytes: pdf, size: 6, type: 'application/pdf' }]);
    await routes.put('/mine/content?path=a.bin', undefined, { raw: Buffer.from('a') });
    expect(received[1]?.type).toBe('application/octet-stream');
    await routes.put('/mine/content?path=a.bin&replace=1', undefined, { raw: Buffer.from('a') });
    await routes.put('/mine/content?path=a.bin&replace=yes', undefined, { raw: Buffer.from('a') });
    expect(replacing).toEqual([false, false, true, false]);
    expect((await routes.put('/projects/p1/content?path=../../x', undefined, { raw: Buffer.from('x') })).status).toBe(400);
    expect((await routes.put('/projects/p2/content?path=a', undefined, { raw: Buffer.from('x') })).status).toBe(404);
  });

  it('says why an upload was refused', async () => {
    const { files, routes } = await setUp();
    files.upload.mockResolvedValue(refused(409, 'a.pdf is a folder'));
    const no = await routes.put('/projects/p1/content?path=a.pdf', undefined, { raw: Buffer.from('x') });
    expect([no.status, no.data]).toEqual([409, { error: 'a.pdf is a folder' }]);
    files.upload.mockResolvedValue({ ok: false, status: 409, why: 'a.pdf is already there', exists: true });
    const there = await routes.put('/projects/p1/content?path=a.pdf', undefined, { raw: Buffer.from('x') });
    expect([there.status, there.data]).toEqual([409, { error: 'a.pdf is already there', exists: true }]);
    files.upload.mockResolvedValue({ ok: false, status: 507, why: 'This needs 1 bytes, and 0 bytes is free', needed: 1, free: 0 });
    const full = await routes.put('/projects/p1/content?path=a.pdf', undefined, { raw: Buffer.from('x') });
    expect([full.status, full.data]).toEqual([507, { error: 'This needs 1 bytes, and 0 bytes is free', needed: 1, free: 0 }]);
  });

  it('says how much room is left for files', async () => {
    const { files, routes } = await setUp();
    files.room.mockResolvedValue({ free: 1234 });
    const room = await routes.get('/room');
    expect([room.status, room.data]).toEqual([200, { free: 1234 }]);
  });

  it('keeps a drop of files in one go, passing on its body and declared length, and answers each file\'s path and id', async () => {
    const { files, routes } = await setUp();
    const drop = dropBody({ dir: 'docs' }, [{ path: 'a.txt', bytes: Buffer.from('a') }]);
    const seen: { bytes: Buffer; declared: number | undefined }[] = [];
    files.drop.mockImplementation(async (_owner, _scope, body, declared) => {
      const parts: Buffer[] = [];
      for await (const part of body) parts.push(Buffer.from(part as Buffer));
      seen.push({ bytes: Buffer.concat(parts), declared });
      return { ok: true, value: { files: [{ path: 'docs/a.txt', id: 'f1' }] } };
    });
    const kept = await routes.post('/conversations/channel-p1/drop', undefined, { raw: drop, headers: { 'content-type': DROP_TYPE } });
    expect([kept.status, kept.data]).toEqual([201, { files: [{ path: 'docs/a.txt', id: 'f1' }] }]);
    expect(seen).toEqual([{ bytes: drop, declared: drop.length }]);
    expect(files.drop).toHaveBeenCalledWith(TEST_USER.id, inChannel, expect.anything(), drop.length);
  });

  it('says why a drop was refused, naming what is already there, and takes a drop only in its own shape and for the person\'s own place', async () => {
    const { files, routes } = await setUp();
    const drop = dropBody({}, [{ path: 'a.txt', bytes: Buffer.from('a') }]);
    files.drop.mockResolvedValue({ ok: false, status: 409, why: '2 files are already there: a.txt, b.txt', exists: ['a.txt', 'b.txt'] });
    const there = await routes.post('/projects/p1/drop', undefined, { raw: drop, headers: { 'content-type': DROP_TYPE } });
    expect([there.status, there.data]).toEqual([409, { error: '2 files are already there: a.txt, b.txt', exists: ['a.txt', 'b.txt'] }]);
    files.drop.mockResolvedValue({ ok: false, status: 507, why: 'This needs 9 bytes, and 1 bytes is free', needed: 9, free: 1 });
    const full = await routes.post('/mine/drop', undefined, { raw: drop, headers: { 'content-type': DROP_TYPE } });
    expect([full.status, full.data]).toEqual([507, { error: 'This needs 9 bytes, and 1 bytes is free', needed: 9, free: 1 }]);
    const wrong = await routes.post('/mine/drop', undefined, { raw: drop, headers: { 'content-type': 'application/octet-stream' } });
    expect([wrong.status, wrong.data]).toEqual([415, { error: `Send a drop as ${DROP_TYPE}.` }]);
    expect((await routes.post('/projects/p2/drop', undefined, { raw: drop, headers: { 'content-type': DROP_TYPE } })).status).toBe(404);
    expect((await routes.post('/conversations/theirs/drop', undefined, { raw: drop, headers: { 'content-type': DROP_TYPE } })).status).toBe(404);
    expect(files.drop).toHaveBeenCalledTimes(2);
  });

  it('gives back a file of the person\'s by its id, shown when asked, and says when they keep none', async () => {
    const { files, routes } = await setUp();
    files.downloadById.calledWith(TEST_USER.id, 'f1').mockImplementation(async () => ({ ok: true, value: { stream: Readable.from([Buffer.from('png')]), size: 3, contentType: 'image/png', name: 'shot.png' } }));
    files.downloadById.calledWith(TEST_USER.id, 'nope').mockResolvedValue(refused(404, 'You keep no file with that id.'));
    const back = await routes.get('/stored/f1?inline=1');
    expect(back.bytes.toString()).toBe('png');
    expect(back.headers['content-type']).toBe('image/png');
    expect(back.headers['content-disposition']).toBe("inline; filename*=UTF-8''shot.png");
    expect(back.headers['content-length']).toBe('3');
    expect((await routes.get('/stored/f1')).headers['content-disposition']).toBe("attachment; filename*=UTF-8''shot.png");
    const none = await routes.get('/stored/nope');
    expect([none.status, none.data]).toEqual([404, { error: 'You keep no file with that id.' }]);
  });

  it('gives a file back as it was stored, as a download unless asked to show it', async () => {
    const { files, routes } = await setUp();
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    files.download.calledWith(TEST_USER.id, inProject, 'docs/brief.pdf').mockImplementation(async () => ({ ok: true, value: { stream: Readable.from([pdf]), size: pdf.length, contentType: 'application/pdf' } }));
    files.download.calledWith(TEST_USER.id, inProject, 'missing.pdf').mockResolvedValue(refused(404, 'There is no file missing.pdf.'));
    const back = await routes.get('/projects/p1/content?path=docs/brief.pdf');
    expect(back.bytes).toEqual(pdf);
    expect(back.headers['content-type']).toBe('application/pdf');
    expect(back.headers['content-disposition']).toBe("attachment; filename*=UTF-8''brief.pdf");
    expect(back.headers['content-length']).toBe('6');
    const shown = await routes.get('/projects/p1/content?path=docs/brief.pdf&inline=1');
    expect(shown.headers['content-disposition']).toBe("inline; filename*=UTF-8''brief.pdf");
    const gone = await routes.get('/projects/p1/content?path=missing.pdf');
    expect([gone.status, gone.data]).toEqual([404, { error: 'There is no file missing.pdf.' }]);
    expect((await routes.get('/projects/p2/content?path=a')).status).toBe(404);
  });

  it('serves a file of unknown size without a length', async () => {
    const { files, routes } = await setUp();
    files.download.mockImplementation(async () => ({ ok: true, value: { stream: Readable.from([Buffer.from('x')]), contentType: 'text/plain' } }));
    expect((await routes.get('/mine/content?path=a.txt')).headers['content-length']).toBeUndefined();
  });

  it('removes a file and moves one, refusing a path that leaves the files', async () => {
    const { files, routes } = await setUp();
    files.remove.calledWith(TEST_USER.id, inProject, 'old/a.txt').mockResolvedValue({ ok: true, value: { path: 'old/a.txt' } });
    files.move.calledWith(TEST_USER.id, inProject, 'a.txt', 'old/a.txt').mockResolvedValue({ ok: true, value: { path: 'old/a.txt' } });
    expect((await routes.delete('/projects/p1/content?path=old/a.txt')).data).toEqual({ path: 'old/a.txt' });
    expect((await routes.post('/projects/p1/move', { from: 'a.txt', to: 'old/a.txt' })).data).toEqual({ path: 'old/a.txt' });
    expect((await routes.post('/projects/p1/move', { from: '../a.txt', to: 'b' })).status).toBe(400);
    expect((await routes.post('/projects/p1/move', { from: 'a.txt', to: '../b' })).status).toBe(400);
    expect((await routes.delete('/projects/p2/content?path=a')).status).toBe(404);
    expect((await routes.post('/projects/p2/move', { from: 'a', to: 'b' })).status).toBe(404);
  });
});

describe('/api/share', () => {
  const served = (contentType: string, name: string, bytes: Buffer, size?: number) => ({ ok: true as const, value: { stream: Readable.from([bytes]), contentType, name, size } });

  it('opens a shared file signed out, inline, with the policy its type allows', async () => {
    const files = mock<Pick<FileService, 'shared'>>();
    const routes = await routesInProcess({ prefix: '/', router: () => shareRouter({ files }) });
    files.shared.calledWith('good').mockImplementation(async () => served('application/pdf', 'brief.pdf', Buffer.from('%PDF'), 4));
    files.shared.calledWith('page').mockImplementation(async () => served('text/html', 'page.html', Buffer.from('<script>alert(1)</script>')));
    const opened = await routes.get('/good');
    expect(opened.bytes.toString()).toBe('%PDF');
    expect(opened.headers['content-disposition']).toBe("inline; filename*=UTF-8''brief.pdf");
    expect(opened.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(opened.headers['content-length']).toBe('4');
    const page = await routes.get('/page');
    expect(String(page.headers['content-security-policy'])).toContain('sandbox');
    expect(page.headers['content-length']).toBeUndefined();
    const download = await routes.get('/good?download=1');
    expect(download.headers['content-disposition']).toBe("attachment; filename*=UTF-8''brief.pdf");
  });

  it('answers a link that is revoked, expired or unknown in plain text', async () => {
    const files = mock<Pick<FileService, 'shared'>>();
    files.shared.mockResolvedValue(refused(404, 'This link has expired or was revoked.'));
    const routes = await routesInProcess({ prefix: '/', router: () => shareRouter({ files }) });
    const gone = await routes.get('/old');
    expect([gone.status, gone.headers['content-type'], gone.text]).toEqual([404, 'text/plain; charset=utf-8', 'This link has expired or was revoked.']);
  });
});
