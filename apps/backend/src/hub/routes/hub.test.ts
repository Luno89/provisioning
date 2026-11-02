import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { FILE_TYPE_HEADER } from '../../files/index.js';
import { objectWith } from '../../platform/lib/test-matchers.js';
import type { HubOutcome, HubService } from '../services/HubService.js';
import { callRouter, type RouterCall } from '../testing/call-router.js';
import { hubRouter, sendRelayed } from './hub.js';

const ann = { id: 'ann', email: 'ann@example.com' };
const succeeded = <T>(value: T): HubOutcome<T> => ({ ok: true, value });
const failed = (status: 400 | 403 | 404 | 409 | 429, why: string): HubOutcome<never> => ({ ok: false, status, why });

function site(vouch?: (req: Request) => Promise<string | undefined>) {
  const hub = mock<HubService>();
  const router = hubRouter({ hub, vouch });
  const call = (route: RouterCall) => callRouter(router, '/api/hub', { user: ann, ...route });
  return { hub, call };
}

describe('/api/hub projects', () => {
  it('lists the projects of whoever asks', async () => {
    const { hub, call } = site();
    hub.mine.calledWith('ann').mockResolvedValue([]);
    const answer = await call({ path: '/projects' });
    expect([answer.status, answer.body]).toEqual([200, []]);
  });

  it('shows a project, or the reason it cannot be shown', async () => {
    const { hub, call } = site();
    hub.view.calledWith('ann', 'abc').mockResolvedValue(succeeded({ role: 'owner' } as never));
    hub.view.calledWith('ann', 'nope').mockResolvedValue(failed(404, 'There is no such project, or you are not on it.'));
    expect(await call({ path: '/projects/abc' })).toMatchObject({ status: 200, body: { role: 'owner' } });
    expect(await call({ path: '/projects/nope' })).toMatchObject({ status: 404, body: { error: 'There is no such project, or you are not on it.' } });
  });

  it('deletes a project by the name typed', async () => {
    const { hub, call } = site();
    hub.delete.mockResolvedValue(succeeded({ deleted: 'abc' }));
    expect(await call({ method: 'DELETE', path: '/projects/abc', json: { name: 'Shop' } })).toMatchObject({ status: 200, body: { deleted: 'abc' } });
    expect(hub.delete).toHaveBeenCalledWith('ann', 'abc', 'Shop');
  });

  it('invites by email with a role, answering that it was made, and lets root vouch through the request', async () => {
    const vouch = vi.fn(async () => 'root-said-so');
    const { hub, call } = site(vouch);
    hub.invite.mockResolvedValue(succeeded({ email: 'bo@example.com', role: 'client', link: 'l', emailed: false }));
    const answer = await call({ method: 'POST', path: '/projects/abc/invites', json: { email: 'bo@example.com', role: 'client' } });
    expect([answer.status, answer.body]).toEqual([201, { email: 'bo@example.com', role: 'client', link: 'l', emailed: false }]);
    const [inviter, projectId, input] = hub.invite.mock.calls[0]!;
    expect([inviter.id, inviter.email, projectId, input]).toEqual(['ann', 'ann@example.com', 'abc', { email: 'bo@example.com', role: 'client' }]);
    expect(await inviter.vouch?.()).toBe('root-said-so');
  });

  it('has nobody to vouch for an invite when none is given', async () => {
    const { hub, call } = site();
    hub.invite.mockResolvedValue(failed(403, 'no'));
    await call({ method: 'POST', path: '/projects/abc/invites', json: { email: 'bo@example.com', role: 'client' } });
    expect(await hub.invite.mock.calls[0]![0].vouch?.()).toBeUndefined();
  });

  it('takes an invite back by the email it was sent to, or by none', async () => {
    const { hub, call } = site();
    hub.takeBack.mockResolvedValue(succeeded({ email: 'bo@example.com' }));
    await call({ method: 'DELETE', path: '/projects/abc/invites?email=bo%40example.com' });
    expect(hub.takeBack).toHaveBeenLastCalledWith('ann', 'abc', 'bo@example.com');
    await call({ method: 'DELETE', path: '/projects/abc/invites' });
    expect(hub.takeBack).toHaveBeenLastCalledWith('ann', 'abc', '');
  });

  it('changes a member\'s role and removes a member', async () => {
    const { hub, call } = site();
    hub.changeRole.mockResolvedValue(succeeded({ role: 'owner' } as never));
    hub.remove.mockResolvedValue(succeeded({ removed: 'bo' }));
    expect((await call({ method: 'PUT', path: '/projects/abc/members/bo', json: { role: 'collaborator' } })).status).toBe(200);
    expect(hub.changeRole).toHaveBeenCalledWith('ann', 'abc', 'bo', 'collaborator');
    expect((await call({ method: 'DELETE', path: '/projects/abc/members/bo' })).body).toEqual({ removed: 'bo' });
    expect(hub.remove).toHaveBeenCalledWith('ann', 'abc', 'bo');
  });

  it('answers invitations: what one is, and taking it', async () => {
    const { hub, call } = site();
    hub.invitation.mockResolvedValue(succeeded({ projectName: 'Shop', role: 'client', email: 'ann@example.com', forYou: true }));
    hub.accept.mockResolvedValue(succeeded({ role: 'client' } as never));
    expect((await call({ path: '/invitations/tok' })).body).toEqual({ projectName: 'Shop', role: 'client', email: 'ann@example.com', forYou: true });
    expect(hub.invitation).toHaveBeenCalledWith(ann, 'tok');
    expect((await call({ method: 'POST', path: '/invitations/tok/accept', json: {} })).status).toBe(200);
    expect(hub.accept).toHaveBeenCalledWith(ann, 'tok');
  });
});

describe('/api/hub board and chats', () => {
  it('reads the board and a chat', async () => {
    const { hub, call } = site();
    hub.boardView.mockResolvedValue(succeeded({ online: true } as never));
    hub.conversation.mockResolvedValue(succeeded({ id: 'channel-p1' }));
    expect((await call({ path: '/projects/abc/board' })).body).toEqual({ online: true });
    expect((await call({ path: '/projects/abc/conversations/channel-p1' })).body).toEqual({ id: 'channel-p1' });
    expect(hub.conversation).toHaveBeenCalledWith('ann', 'abc', 'channel-p1');
  });

  it('posts a message as a person, answering that it was made', async () => {
    const { hub, call } = site();
    hub.post.mockResolvedValue(succeeded({ message: { role: 'user', content: 'hi', at: 'now' } }));
    const answer = await call({ method: 'POST', path: '/projects/abc/conversations/channel-p1/messages', json: { content: 'hi', askKoala: true } });
    expect(answer.status).toBe(201);
    expect(hub.post).toHaveBeenCalledWith(ann, 'abc', 'channel-p1', { content: 'hi', askKoala: true });
  });

  it('keeps a request for the owner\'s instance, answering that it was accepted for later', async () => {
    const { hub, call } = site();
    hub.request.mockResolvedValue(succeeded({ id: 'r1' } as never));
    const answer = await call({ method: 'POST', path: '/projects/abc/requests', json: { kind: 'accept-task', taskId: 'k1' } });
    expect([answer.status, answer.body]).toEqual([202, { id: 'r1' }]);
    expect(hub.request).toHaveBeenCalledWith(ann, 'abc', { kind: 'accept-task', taskId: 'k1' });
  });

  it('turns away a request that is refused with the reason', async () => {
    const { hub, call } = site();
    hub.request.mockResolvedValue(failed(403, 'only an owner or a collaborator can change the work'));
    expect(await call({ method: 'POST', path: '/projects/abc/requests', json: { kind: 'accept-task' } })).toMatchObject({ status: 403, body: { error: 'only an owner or a collaborator can change the work' } });
  });
});

describe('/api/hub the run feed, relayed from the owner\'s instance', () => {
  it('asks for a run\'s turns from where the member left off, under a run when named', async () => {
    const { hub, call } = site();
    hub.relay.mockResolvedValue(succeeded({ kind: 'json', status: 200, body: { entries: [] } }));
    expect(await call({ path: '/projects/abc/live/turns/grove-run-t1~1?after=4&under=run-2' })).toMatchObject({ status: 200, body: { entries: [] } });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'turns', { turnId: 'grove-run-t1~1', after: 4, under: 'run-2' }, undefined);
    await call({ path: '/projects/abc/live/turns/grove-run-t1~1' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'turns', { turnId: 'grove-run-t1~1', after: 0 }, undefined);
  });

  it('asks for a procedure a run used, how runs ended, and the extensions', async () => {
    const { hub, call } = site();
    hub.relay.mockResolvedValue(succeeded({ kind: 'json', status: 200, body: {} }));
    await call({ path: '/projects/abc/live/procedures/grove-run?turn=grove-run-t1~1' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'procedure', { id: 'grove-run', turnId: 'grove-run-t1~1' }, undefined);
    await call({ path: '/projects/abc/live/procedures/grove-run' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'procedure', { id: 'grove-run', turnId: '' }, undefined);
    await call({ path: '/projects/abc/live/endings?turn=grove-run-t1~1&ids=a,,b' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'endings', { turnId: 'grove-run-t1~1', ids: ['a', 'b'] }, undefined);
    await call({ path: '/projects/abc/live/endings' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'endings', { turnId: '', ids: [] }, undefined);
    await call({ path: '/projects/abc/live/extensions' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'extensions', {}, undefined);
  });

  it('says why the owner\'s instance could not be asked', async () => {
    const { hub, call } = site();
    hub.relay.mockResolvedValue(failed(409, 'The owner\'s instance is offline'));
    expect(await call({ path: '/projects/abc/live/extensions' })).toMatchObject({ status: 409, body: { error: 'The owner\'s instance is offline' } });
  });
});

describe('/api/hub the repository', () => {
  it('lists the files on main and reads one', async () => {
    const { hub, call } = site();
    hub.repository.mockResolvedValue(succeeded({ files: ['a.txt'] }));
    hub.repositoryFile.mockResolvedValue(succeeded({ path: 'dir/a.txt', content: 'hello' }));
    expect((await call({ path: '/projects/abc/repository' })).body).toEqual({ files: ['a.txt'] });
    expect((await call({ path: '/projects/abc/repository/file?path=dir/a.txt' })).body).toEqual({ path: 'dir/a.txt', content: 'hello' });
    expect(hub.repositoryFile).toHaveBeenCalledWith('ann', 'abc', 'dir/a.txt');
  });

  it('refuses a path that climbs out of the repository before asking', async () => {
    const { hub, call } = site();
    const answer = await call({ path: '/projects/abc/repository/file?path=../secrets' });
    expect(answer.status).toBe(400);
    expect(hub.repositoryFile).not.toHaveBeenCalled();
  });
});

describe('/api/hub the project\'s files, relayed from the owner\'s instance', () => {
  const json = succeeded({ kind: 'json' as const, status: 200, body: [] });

  it('lists a folder, or the top of the project, and searches by name', async () => {
    const { hub, call } = site();
    hub.relay.mockResolvedValue(json);
    await call({ path: '/projects/abc/files/list?dir=contracts' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.list', { dir: 'contracts' }, undefined);
    await call({ path: '/projects/abc/files/list' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.list', { dir: '' }, undefined);
    await call({ path: '/projects/abc/files/search?q=nda' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.search', { q: 'nda' }, undefined);
    await call({ path: '/projects/abc/files/search' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.search', { q: '' }, undefined);
  });

  it('refuses a folder or file name that climbs out of the project before asking anyone', async () => {
    const { hub, call } = site();
    for (const route of [
      { path: '/projects/abc/files/list?dir=../x' },
      { method: 'POST' as const, path: '/projects/abc/files/folder', json: { path: '../x' } },
      { path: '/projects/abc/files/content?path=../x' },
      { method: 'DELETE' as const, path: '/projects/abc/files/content?path=../x' },
      { method: 'PUT' as const, path: '/projects/abc/files/content?path=../x', bytes: Buffer.from('x') },
      { method: 'POST' as const, path: '/projects/abc/files/move', json: { from: '../x', to: 'y' } },
      { method: 'POST' as const, path: '/projects/abc/files/move', json: { from: 'x', to: '../y' } },
    ]) expect((await call(route)).status).toBe(400);
    expect(hub.relay).not.toHaveBeenCalled();
  });

  it('makes a folder, removes a file and moves a file', async () => {
    const { hub, call } = site();
    hub.relay.mockResolvedValue(json);
    await call({ method: 'POST', path: '/projects/abc/files/folder', json: { path: 'from-cy' } });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.folder', { path: 'from-cy' }, undefined);
    await call({ method: 'DELETE', path: '/projects/abc/files/content?path=a.txt' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.remove', { path: 'a.txt' }, undefined);
    await call({ method: 'POST', path: '/projects/abc/files/move', json: { from: 'a.txt', to: 'b.txt' } });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.move', { from: 'a.txt', to: 'b.txt' }, undefined);
  });

  it('streams a file back with the type and the name it was stored under, as a download unless shown inline', async () => {
    const { hub, call } = site();
    hub.relay.mockResolvedValue(succeeded({ kind: 'stream' as const, status: 200, type: 'application/pdf', name: 'nda.pdf', size: 3, stream: Readable.from([Buffer.from('pdf')]) }));
    const answer = await call({ path: '/projects/abc/files/content?path=contracts/nda.pdf' });
    expect(hub.relay).toHaveBeenLastCalledWith(ann, 'abc', 'files.read', { path: 'contracts/nda.pdf' }, undefined);
    expect([answer.status, answer.text, answer.headers['content-length']]).toEqual([200, 'pdf', '3']);
    expect(String(answer.headers['content-disposition'])).toMatch(/^attachment; filename\*=UTF-8''nda\.pdf$/);
  });

  it('shows a file inline when asked and it is one that is shown', async () => {
    const { hub, call } = site();
    hub.relay.mockResolvedValue(succeeded({ kind: 'stream' as const, status: 200, type: 'text/plain', size: 2, stream: Readable.from([Buffer.from('hi')]) }));
    const answer = await call({ path: '/projects/abc/files/content?path=notes/a.txt&inline=1' });
    expect(String(answer.headers['content-disposition'])).toMatch(/^inline; filename\*=UTF-8''a\.txt$/);
  });

  it('hands a member\'s upload to the owner\'s instance as the stream it arrives as, with its type and size', async () => {
    const { hub, call } = site();
    const received: Buffer[] = [];
    hub.relay.mockImplementation(async (_who, _id, _op, _args, upload) => {
      for await (const chunk of upload!.stream) received.push(Buffer.from(chunk as Buffer));
      return succeeded({ kind: 'json' as const, status: 201, body: { path: 'contracts/nda.pdf' } });
    });
    const answer = await call({ method: 'PUT', path: '/projects/abc/files/content?path=contracts/nda.pdf', bytes: Buffer.from('%PDF'), headers: { [FILE_TYPE_HEADER]: 'application/pdf' } });
    expect([answer.status, answer.body]).toEqual([201, { path: 'contracts/nda.pdf' }]);
    expect(Buffer.concat(received).toString()).toBe('%PDF');
    expect(hub.relay).toHaveBeenCalledWith(ann, 'abc', 'files.upload', { path: 'contracts/nda.pdf', type: 'application/pdf', size: 4 }, objectWith({ type: 'application/pdf', size: 4 }));
  });

  it('takes an upload without a declared type as plain bytes', async () => {
    const { hub, call } = site();
    hub.relay.mockImplementation(async (_who, _id, _op, _args, upload) => {
      for await (const chunk of upload!.stream) void chunk;
      return succeeded({ kind: 'json' as const, status: 200, body: {} });
    });
    await call({ method: 'PUT', path: '/projects/abc/files/content?path=a.bin', bytes: Buffer.alloc(0) });
    expect(hub.relay.mock.calls[0]![3]).toEqual({ path: 'a.bin', type: 'application/octet-stream', size: 0 });
  });
});

describe('sending the owner\'s instance\'s answer on', () => {
  function reply() {
    const res = mock<Response>();
    res.status.mockReturnValue(res);
    res.set.mockReturnValue(res);
    return res;
  }

  it('sends a json answer with its status', () => {
    const res = reply();
    sendRelayed(res, { kind: 'json', status: 409, body: { error: 'x' } }, false, 'file');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'x' });
  });

  it('streams a file under the name it came with, or the one the member asked for when it came with none', () => {
    const named = reply();
    const stream = Readable.from([]);
    sendRelayed(named, { kind: 'stream', status: 200, type: 'text/plain', name: 'given.txt', stream }, false, 'asked.txt');
    expect(named.set).toHaveBeenCalledWith(objectWith({ 'Content-Disposition': "attachment; filename*=UTF-8''given.txt" }));
    expect(named.setHeader).not.toHaveBeenCalled();
    const unnamed = reply();
    sendRelayed(unnamed, { kind: 'stream', status: 200, type: 'text/plain', size: 0, stream: Readable.from([]) }, false, 'asked.txt');
    expect(unnamed.set).toHaveBeenCalledWith(objectWith({ 'Content-Disposition': "attachment; filename*=UTF-8''asked.txt" }));
    expect(unnamed.setHeader).toHaveBeenCalledWith('Content-Length', '0');
  });

  it('ends the response when the file stream breaks', () => {
    const res = reply();
    const stream = new Readable({ read() { this.destroy(new Error('cut')); } });
    sendRelayed(res, { kind: 'stream', status: 200, type: 'text/plain', stream }, false, 'a.txt');
    return new Promise<void>((resolve) => stream.on('close', () => { expect(res.destroy).toHaveBeenCalled(); resolve(); }));
  });
});
