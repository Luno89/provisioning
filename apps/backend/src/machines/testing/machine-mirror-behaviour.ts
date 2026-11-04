import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '../../platform/lib/db-interface.js';
import type { AccountMachine } from '../services/MachineAccounts.js';
import { MachineMirror, type MachineMirrorDeps } from '../services/MachineMirror.js';

export function machineMirrorBehaviour(make: () => Promise<Database>): void {
  let db: Database;
  let fromRoot: AccountMachine[];
  let machines: ReturnType<typeof mock<MachineMirrorDeps['machines']>>;
  const desk: AccountMachine = { id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', os: 'Linux', meshIp: '100.64.0.9', createdAt: '2026-11-04T00:00:00Z' };
  const mirror = () => new MachineMirror({ store: db.machines, root: { list: async () => fromRoot }, machines });
  const here = async () => db.machines.getLocalAgentDevices();

  beforeEach(async () => {
    db = await make();
    fromRoot = [];
    machines = mock<MachineMirrorDeps['machines']>();
    machines.adopt.mockResolvedValue(undefined);
    machines.forget.mockResolvedValue(undefined);
  });

  describe('an instance keeping root\'s list of its owner\'s machines', () => {
    it('takes a machine root has, making its project once, and keeps what this instance learned of it', async () => {
      fromRoot = [desk];
      await mirror().sync();
      expect(await here()).toEqual([expect.objectContaining(desk)]);
      expect(machines.adopt).toHaveBeenCalledWith(desk);
      await db.machines.updateLocalAgentDevice('desk', { set: { agents: [{ id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found' }] } });
      fromRoot = [{ ...desk, name: 'renamed', meshIp: '100.64.0.10' }];
      await mirror().sync();
      expect(await here()).toEqual([expect.objectContaining({ name: 'renamed', meshIp: '100.64.0.10', agents: [expect.objectContaining({ id: 'gemini' })] })]);
      expect(machines.adopt).toHaveBeenCalledTimes(1);
    });

    it('drops what root no longer says, and forgets a machine root removed', async () => {
      fromRoot = [desk];
      await mirror().sync();
      fromRoot = [{ ...desk, os: undefined, meshIp: undefined }];
      await mirror().sync();
      const kept = (await here())[0]!;
      expect(kept.os).toBeUndefined();
      expect(kept.meshIp).toBeUndefined();
      fromRoot = [];
      await mirror().sync();
      expect(await here()).toEqual([]);
      expect(machines.forget).toHaveBeenCalledWith(expect.objectContaining({ id: 'desk', ownerId: 'bo' }));
    });

    it('reads root once more when asked again while reading, and says nothing changed when root is unchanged', async () => {
      fromRoot = [desk];
      const synced = mirror();
      const updates = vi.spyOn(db.machines, 'updateLocalAgentDevice');
      await Promise.all([synced.sync(), synced.sync(), synced.sync()]);
      expect(await here()).toHaveLength(1);
      expect(machines.adopt).toHaveBeenCalledTimes(1);
      await synced.sync();
      expect(updates).not.toHaveBeenCalled();
    });

    it('still holds a machine whose project could not be made, saying so', async () => {
      machines.adopt.mockRejectedValue(new Error('no repository'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      fromRoot = [desk];
      await mirror().sync();
      expect(await here()).toHaveLength(1);
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('no repository'));
      warned.mockRestore();
    });
  });
}
