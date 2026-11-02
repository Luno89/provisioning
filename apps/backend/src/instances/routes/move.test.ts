import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'express';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { moveRouter } from './move.js';
import type { MoveExport } from '../services/MoveExport.js';

const TOKEN = 'x-koala-move-token';
const on = (router: Router) => routesInProcess({ prefix: '/api/move', router: () => router, user: PERSON });

function opened(text: string, type = 'text/plain', done: Promise<void> = Promise.resolve()) {
  return { out: Readable.from([Buffer.from(text)]), done, type };
}

describe('the parts of an instance, handed to root', () => {
  it('answers 404 for something that is not a part of an instance', async () => {
    const move = mock<MoveExport>();
    const answer = await (await on(moveRouter({ move }))).get('/api/move/parts/passwords', { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(404);
    expect(answer.data).toEqual({ error: 'that is not a part of an instance' });
    expect(move.check).not.toHaveBeenCalled();
  });

  it('refuses a part root did not ask for, before anything stops', async () => {
    const move = mock<MoveExport>();
    move.check.calledWith('t', 'keys').mockResolvedValue({ status: 401, error: 'root did not ask for this (bad signature)' });
    const answer = await (await on(moveRouter({ move }))).get('/api/move/parts/keys', { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(401);
    expect(answer.data).toEqual({ error: 'root did not ask for this (bad signature)' });
    expect(move.freeze).not.toHaveBeenCalled();
  });

  it('says why the instance will not stop for the move', async () => {
    const move = mock<MoveExport>();
    move.check.mockResolvedValue(undefined);
    move.freeze.mockResolvedValue({ status: 409, error: 'finish or stop what runs first, then start the move again: a chat' });
    const answer = await (await on(moveRouter({ move }))).get('/api/move/parts/keys', { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(409);
    expect(answer.data).toEqual({ error: 'finish or stop what runs first, then start the move again: a chat' });
    expect(move.open).not.toHaveBeenCalled();
  });

  it('streams a part with its type, never to be cached', async () => {
    const move = mock<MoveExport>();
    move.check.calledWith('t', 'keys').mockResolvedValue(undefined);
    move.freeze.mockResolvedValue(undefined);
    move.open.calledWith('keys').mockReturnValue(opened('SESSION_KEY=x\n'));
    const answer = await (await on(moveRouter({ move }))).get('/api/move/parts/keys', { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('SESSION_KEY=x\n');
    expect(answer.headers).toMatchObject({ 'content-type': 'text/plain', 'cache-control': 'no-store' });
  });

  it('streams a volume when the part names one', async () => {
    const move = mock<MoveExport>();
    move.check.mockResolvedValue(undefined);
    move.freeze.mockResolvedValue(undefined);
    move.volume.calledWith('books', 'data-web-0').mockReturnValue(opened('tarball', 'application/gzip'));
    const answer = await (await on(moveRouter({ move }))).get('/api/move/parts/volume:books:data-web-0', { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('tarball');
    expect(answer.headers['content-type']).toBe('application/gzip');
    expect(move.open).not.toHaveBeenCalled();
  });

  it('answers 500 with the reason when the part cannot be opened', async () => {
    const move = mock<MoveExport>();
    move.check.mockResolvedValue(undefined);
    move.freeze.mockResolvedValue(undefined);
    move.open.mockImplementation(() => { throw new Error('this instance has no DATA_KEY'); });
    const answer = await (await on(moveRouter({ move }))).get('/api/move/parts/keys', { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'this instance has no DATA_KEY' });
  });

  it('logs a part that stopped part way, and cuts the answer off', async () => {
    const move = mock<MoveExport>();
    const log = vi.fn();
    move.check.mockResolvedValue(undefined);
    move.freeze.mockResolvedValue(undefined);
    const out = new PassThrough();
    let fail: (err: Error) => void = () => undefined;
    const done = new Promise<void>((_resolve, reject) => { fail = reject; });
    move.open.mockReturnValue({ out, done, type: 'application/gzip' });
    const answering = on(moveRouter({ move, log })).then((routes) => routes.get('/api/move/parts/data', { headers: { [TOKEN]: 't' } }));
    out.write('half');
    await new Promise((resolve) => setImmediate(resolve));
    fail(new Error('tar ended with 2'));
    out.end();
    await answering;
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith('[move] data stopped part way: tar ended with 2');
  });
});

describe('root telling an instance its move stopped', () => {
  it('refuses a thaw root did not ask for', async () => {
    const move = mock<MoveExport>();
    move.check.calledWith('t', 'thaw').mockResolvedValue({ status: 409, error: 'root\'s request for this was already answered; ask again' });
    const answer = await (await on(moveRouter({ move }))).post('/api/move/thaw', undefined, { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(409);
    expect(move.thaw).not.toHaveBeenCalled();
  });

  it('takes work again', async () => {
    const move = mock<MoveExport>();
    move.check.mockResolvedValue(undefined);
    move.thaw.mockResolvedValue([]);
    const answer = await (await on(moveRouter({ move }))).post('/api/move/thaw', undefined, { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ thawed: true });
  });

  it('says which apps it could not start again, though it takes work itself', async () => {
    const move = mock<MoveExport>();
    move.check.mockResolvedValue(undefined);
    move.thaw.mockResolvedValue(['books\'s apps could not be started again: forbidden', 'its self-upgrade could not be switched back on: forbidden']);
    const answer = await (await on(moveRouter({ move }))).post('/api/move/thaw', undefined, { headers: { [TOKEN]: 't' } });
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'it takes work again, but books\'s apps could not be started again: forbidden; its self-upgrade could not be switched back on: forbidden' });
  });
});
