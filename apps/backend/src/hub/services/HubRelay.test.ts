import { describe, expect, it } from 'vitest';
import { HubRelay, InstanceOffline, type InstanceLine, type RelayCall } from './HubRelay.js';

const bo = { personId: 'bo', email: 'bo@example.com', role: 'collaborator' as const };

const line = () => {
  const calls: RelayCall[] = [];
  const changed: string[] = [];
  const held: InstanceLine = { call: (call) => calls.push(call), changed: (projectId) => changed.push(projectId) };
  return { held, calls, changed };
};

describe('relaying a member\'s call to the owner\'s instance', () => {
  it('refuses at once while the owner\'s instance is not connected', async () => {
    const relay = new HubRelay();
    expect(relay.online('inst-1')).toBe(false);
    await expect(relay.call('inst-1', 'p', 'extensions', {}, bo)).rejects.toBeInstanceOf(InstanceOffline);
    await expect(relay.call(undefined, 'p', 'extensions', {}, bo)).rejects.toBeInstanceOf(InstanceOffline);
  });

  it('hands a call to the instance\'s line and its answer back, and finds the call until it is answered', async () => {
    const relay = new HubRelay();
    const one = line();
    relay.connect('inst-1', one.held);
    const asked = relay.call('inst-1', 'p', 'turns', { turnId: 't' }, bo);
    const [call] = one.calls;
    expect(call).toMatchObject({ projectId: 'p', op: 'turns', args: { turnId: 't' }, as: bo });
    expect(relay.callOf(call!.id)).toBe(call);
    expect(relay.answer(call!.id, { kind: 'json', status: 200, body: ['x'] })).toBe(true);
    expect(await asked).toEqual({ kind: 'json', status: 200, body: ['x'] });
    expect(relay.callOf(call!.id)).toBeUndefined();
    expect(relay.answer(call!.id, { kind: 'json', status: 200, body: [] })).toBe(false);
  });

  it('tells every line of the instance that a project changed, and no other instance', () => {
    const relay = new HubRelay();
    const [first, second, other] = [line(), line(), line()];
    relay.connect('inst-1', first.held);
    relay.connect('inst-1', second.held);
    relay.connect('inst-2', other.held);
    relay.changed('inst-1', 'p');
    relay.changed(undefined, 'q');
    expect(first.changed).toEqual(['p']);
    expect(second.changed).toEqual(['p']);
    expect(other.changed).toEqual([]);
  });

  it('fails at once the calls a line took and never answered when that line closes, and is offline once its last line has', async () => {
    const relay = new HubRelay();
    const [first, second] = [line(), line()];
    const closeFirst = relay.connect('inst-1', first.held);
    const asked = relay.call('inst-1', 'p', 'turns', {}, bo).catch((err: Error) => err);
    const closeSecond = relay.connect('inst-1', second.held);

    closeFirst();
    const lost = await asked;
    expect(lost).toBeInstanceOf(InstanceOffline);
    expect((lost as Error).message).toBe('The owner\'s instance went offline before it answered.');
    expect(relay.online('inst-1')).toBe(true);

    const kept = relay.call('inst-1', 'p', 'extensions', {}, bo);
    relay.answer(second.calls[0]!.id, { kind: 'json', status: 200, body: [] });
    expect(await kept).toEqual({ kind: 'json', status: 200, body: [] });

    closeSecond();
    expect(relay.online('inst-1')).toBe(false);
  });
});
