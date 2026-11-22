import { describe, expect, it } from 'vitest';
import type { MachinesStore } from '../store.js';

const device = { id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/home/person/koala', createdAt: '2026-10-10T00:00:00.000Z', os: 'old' };

export function machinesStoreContract(make: () => Promise<MachinesStore>): void {
  describe('a person\'s machines', () => {
    it('keeps a machine as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveLocalAgentDevice(device);
      await store.saveLocalAgentDevice({ ...device, id: 'laptop', name: 'laptop' });
      expect(await store.getLocalAgentDevices()).toEqual(expect.arrayContaining([device, { ...device, id: 'laptop', name: 'laptop' }]));
      await store.saveLocalAgentDevice({ id: 'desk', ownerId: 'owner-1', name: 'renamed', rootDir: '/home/person/koala', createdAt: device.createdAt });
      expect((await store.getLocalAgentDevices()).find((stored) => stored.id === 'desk')).toEqual({ id: 'desk', ownerId: 'owner-1', name: 'renamed', rootDir: '/home/person/koala', createdAt: device.createdAt });
      await store.deleteLocalAgentDevice('desk');
      expect((await store.getLocalAgentDevices()).map((stored) => stored.id)).toEqual(['laptop']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveLocalAgentDevice(device);
      const [read] = await store.getLocalAgentDevices();
      read!.name = 'changed';
      expect((await store.getLocalAgentDevices())[0]?.name).toBe('desk');
    });

    it('changes only the fields named, so two changes at once both land', async () => {
      const store = await make();
      await store.saveLocalAgentDevice(device);
      await Promise.all([
        store.updateLocalAgentDevice('desk', { set: { lastSeenAt: '2026-10-29T00:00:00.000Z' } }),
        store.updateLocalAgentDevice('desk', { set: { agentBundle: 'new' }, when: { agentBundle: null } }),
        store.updateLocalAgentDevice('desk', { set: { meshIp: '100.64.0.9' } }),
      ]);
      expect((await store.getLocalAgentDevices())[0]).toMatchObject({ os: 'old', agentBundle: 'new', lastSeenAt: '2026-10-29T00:00:00.000Z', meshIp: '100.64.0.9' });
    });

    it('applies a change only while its condition holds, and says whether it did', async () => {
      const store = await make();
      await store.saveLocalAgentDevice({ ...device, agentBundle: 'new' });
      expect(await store.updateLocalAgentDevice('desk', { set: { agentBundle: 'another' }, when: { agentBundle: null } })).toBe(false);
      expect(await store.updateLocalAgentDevice('desk', { set: { os: 'new' }, unset: ['agentBundle'], when: { agentBundle: 'stale' } })).toBe(false);
      expect(await store.updateLocalAgentDevice('desk', { set: { os: 'new' }, unset: ['agentBundle'], when: { agentBundle: 'new' } })).toBe(true);
      const [stored] = await store.getLocalAgentDevices();
      expect(stored).toMatchObject({ os: 'new' });
      expect(stored).not.toHaveProperty('agentBundle');
    });

    it('changes nothing, and says so, for a machine it does not have or a change that names nothing', async () => {
      const store = await make();
      expect(await store.updateLocalAgentDevice('gone', { set: { name: 'x' } })).toBe(false);
      await store.saveLocalAgentDevice(device);
      expect(await store.updateLocalAgentDevice('desk', {})).toBe(false);
      expect(await store.getLocalAgentDevices()).toEqual([device]);
    });

    it('marks every machine of a person being removed once, keeping when the first mark was made, and names each one', async () => {
      const store = await make();
      await store.saveLocalAgentDevice(device);
      await store.saveLocalAgentDevice({ ...device, id: 'tower', name: 'Tower' });
      await store.saveLocalAgentDevice({ ...device, id: 'other', ownerId: 'owner-2', name: 'Other' });
      const marked = await store.markDevicesRemoving('owner-1', '2026-11-21T10:00:00.000Z');
      expect([...marked].sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: 'desk', name: 'desk' }, { id: 'tower', name: 'Tower' }]);
      expect(await store.markDevicesRemoving('owner-1', '2026-11-21T11:00:00.000Z')).toHaveLength(2);
      const stored = await store.getLocalAgentDevices();
      expect(stored.filter((entry) => entry.removal).map((entry) => [entry.id, entry.removal!.startedAt]).sort()).toEqual([['desk', '2026-11-21T10:00:00.000Z'], ['tower', '2026-11-21T10:00:00.000Z']]);
    });

    it('hears a machine marked for removal, and no other write of a machine', async () => {
      const store = await make();
      await store.saveLocalAgentDevice(device);
      const heard: string[] = [];
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const watching = store.watchDeviceRemovals((written) => { heard.push(written.id); finish(); });
      await watching.ready;
      await store.updateLocalAgentDevice('desk', { set: { lastSeenAt: '2026-11-21T09:00:00.000Z' } });
      await store.markDevicesRemoving('owner-1', '2026-11-21T10:00:00.000Z');
      await done;
      await watching.close();
      expect(heard).toEqual(['desk']);
    });

    it('hears a machine removed while something waits for it to go, and says at once of one already gone that it is removed', async () => {
      const store = await make();
      await store.saveLocalAgentDevice(device);
      const waiting = store.untilDeviceGone('desk', new AbortController().signal);
      await store.deleteLocalAgentDevice('desk');
      expect(await waiting).toBe('removed');
      expect(await store.untilDeviceGone('never-joined', new AbortController().signal)).toBe('removed');
    });

    it('stops waiting for a machine to go when asked to, while the machine stays', async () => {
      const store = await make();
      await store.saveLocalAgentDevice(device);
      const stop = new AbortController();
      const waiting = store.untilDeviceGone('desk', stop.signal);
      stop.abort();
      expect(await waiting).toBe('stopped');
      const stopped = new AbortController();
      stopped.abort();
      expect(await store.untilDeviceGone('desk', stopped.signal)).toBe('stopped');
      expect((await store.getLocalAgentDevices()).map((stored) => stored.id)).toEqual(['desk']);
    });

    it('hands a join code out once, keeping the join\'s record with when it was used', async () => {
      const store = await make();
      const code = { hash: 'h1', id: 'join-1', ownerId: 'owner-1', expiresAt: '2030-01-01T00:00:00.000Z', keptUntil: '2030-01-01T00:00:00.000Z' };
      await store.saveMachineJoinCode(code);
      expect(await store.takeMachineJoinCode('h1', '2029-12-31T23:00:00.000Z')).toEqual(code);
      expect(await store.takeMachineJoinCode('h1', '2029-12-31T23:30:00.000Z')).toBeUndefined();
      expect(await store.takeMachineJoinCode('never', '2029-12-31T23:30:00.000Z')).toBeUndefined();
      expect(await store.getMachineJoin('h1')).toEqual({ ...code, usedAt: '2029-12-31T23:00:00.000Z' });
      expect(await store.getMachineJoin('never')).toBeUndefined();
    });

    const join = (hash: string, ownerId: string, more: Record<string, unknown> = {}) =>
      ({ hash, id: `id-${hash}`, ownerId, expiresAt: '2030-01-01T00:00:00.000Z', keptUntil: '2030-01-01T00:00:00.000Z', ...more });
    const stage = { stage: 'k3s', title: 'Installing k3s', state: 'failed' as const, why: 'the download differs', at: '2029-12-31T23:10:00.000Z' };

    it('records a join\'s stage and the machine it made, keeps it once told to, and lists only a person\'s joins that reported', async () => {
      const store = await make();
      await store.saveMachineJoinCode(join('h1', 'owner-1'));
      await store.saveMachineJoinCode(join('h2', 'owner-1'));
      await store.saveMachineJoinCode(join('h3', 'owner-2'));
      expect(await store.updateMachineJoin('h1', { set: { progress: stage, deviceId: 'desk' }, unset: ['keptUntil'] })).toBe(true);
      expect(await store.updateMachineJoin('h3', { set: { progress: stage } })).toBe(true);
      expect(await store.updateMachineJoin('h3', { set: { progress: { stage: 'k3s', title: 'Installing k3s', state: 'started', at: stage.at } } })).toBe(true);
      expect(await store.updateMachineJoin('gone', { set: { deviceId: 'desk' } })).toBe(false);
      const { keptUntil: _kept, ...kept } = join('h1', 'owner-1');
      expect(await store.getReportedMachineJoins('owner-1')).toEqual([{ ...kept, progress: stage, deviceId: 'desk' }]);
      const [theirs] = await store.getReportedMachineJoins('owner-2');
      expect(theirs?.progress).toEqual({ stage: 'k3s', title: 'Installing k3s', state: 'started', at: stage.at });
      expect(theirs?.progress).not.toHaveProperty('why');
    });

    it('removes one join, or every join of a machine but the one named', async () => {
      const store = await make();
      await store.saveMachineJoinCode(join('h1', 'owner-1', { deviceId: 'desk', progress: stage }));
      await store.saveMachineJoinCode(join('h2', 'owner-1', { deviceId: 'desk', progress: stage }));
      await store.saveMachineJoinCode(join('h3', 'owner-1', { deviceId: 'laptop', progress: stage }));
      await store.saveMachineJoinCode(join('h4', 'owner-1', { deviceId: 'desk', progress: stage }));
      expect((await store.getMachineJoinsOf('desk')).map((each) => each.hash).sort()).toEqual(['h1', 'h2', 'h4']);
      expect(await store.getMachineJoinsOf('nowhere')).toEqual([]);
      expect(await store.deleteMachineJoinsOf('desk', 'h4')).toBe(2);
      expect((await store.getReportedMachineJoins('owner-1')).map((each) => each.hash).sort()).toEqual(['h3', 'h4']);
      expect(await store.deleteMachineJoin('h3')).toBe(true);
      expect(await store.deleteMachineJoin('h3')).toBe(false);
      expect(await store.deleteMachineJoinsOf('desk')).toBe(1);
      expect(await store.getReportedMachineJoins('owner-1')).toEqual([]);
    });
  });
}
