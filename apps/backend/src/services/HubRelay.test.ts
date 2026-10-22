import { describe, expect, it, vi } from 'vitest';
import { HubRelay, InstanceOffline, OFFLINE_AFTER_MS } from './HubRelay.js';

const bo = { personId: 'bo', email: 'bo@example.com', role: 'collaborator' as const };

describe('relaying a member\'s call to the owner\'s instance', () => {
  it('refuses at once while the owner\'s instance is not listening', async () => {
    const relay = new HubRelay(Date.now, 60_000);
    await expect(relay.call('p', 'files.list', { dir: '' }, bo)).rejects.toBeInstanceOf(InstanceOffline);
    relay.stop();
  });

  it('hands a call to the instance that is waiting for one, and its answer back', async () => {
    const relay = new HubRelay(Date.now, 60_000);
    const taking = relay.take('p', new Promise(() => undefined));
    const answered = relay.call('p', 'files.list', { dir: '' }, bo);
    const call = await taking;
    expect(call).toMatchObject({ op: 'files.list', args: { dir: '' }, as: bo });
    relay.answer(call!.id, { kind: 'json', status: 200, body: [] });
    expect(await answered).toEqual({ kind: 'json', status: 200, body: [] });
    relay.stop();
  });

  it('queues a call made between two polls and hands it to the next one', async () => {
    const relay = new HubRelay(Date.now, 60_000);
    let close!: () => void;
    const polling = relay.take('p', new Promise<void>((resolve) => { close = resolve; }));
    close();
    expect(await polling).toBeUndefined();
    expect(relay.online('p')).toBe(true);
    const answered = relay.call('p', 'turns', { turnId: 't' }, bo);
    const call = await relay.take('p', new Promise(() => undefined));
    expect(call?.op).toBe('turns');
    relay.answer(call!.id, { kind: 'json', status: 200, body: { entries: [] } });
    expect(await answered).toMatchObject({ status: 200 });
    relay.stop();
  });

  it('fails calls the instance took but never answered once it stops polling', async () => {
    vi.useFakeTimers();
    let now = 0;
    const relay = new HubRelay(() => now, 1_000);
    let close!: () => void;
    const polling = relay.take('p', new Promise<void>((resolve) => { close = resolve; }));
    const taken = relay.call('p', 'turns', { turnId: 't' }, bo).catch((err: Error) => err);
    expect((await polling)?.op).toBe('turns');
    const queued = relay.call('p', 'extensions', {}, bo).catch((err: Error) => err);
    close();
    now += OFFLINE_AFTER_MS + 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await taken).toBeInstanceOf(InstanceOffline);
    expect(await queued).toBeInstanceOf(InstanceOffline);
    expect(relay.online('p')).toBe(false);
    relay.stop();
    vi.useRealTimers();
  });
});
