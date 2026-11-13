import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '../../platform/lib/db-interface.js';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import { tokenLifetime } from '../lib/device-tokens.js';
import { MachineClusters } from '../services/MachineClusters.js';
import { MachineService, type MachineAccountSide, type MachineDevices, type MachineDeps } from '../services/MachineService.js';

export function machineServiceBehaviour(make: () => Promise<Database>): void {
  const DAY = 24 * 60 * 60 * 1000;
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  let db: Database;
  let devices: ReturnType<typeof mock<MachineDevices>>;
  let projects: ReturnType<typeof mock<Required<MachineDeps['projects']>>>;
  let accounts: ReturnType<typeof mock<MachineAccountSide>>;
  let clock: Date;

  const service = (over: Partial<MachineDeps> = {}) => new MachineService({
    store: db.machines,
    devices,
    projects,
    accounts,
    now: () => clock,
    ...over,
  });

  const device = (over: Partial<LocalAgentDeviceMetadata> = {}): LocalAgentDeviceMetadata => ({
    id: 'dev-1', ownerId: 'bo', name: 'Desk', rootDir: '/x', tokenHash: 'h'.repeat(64), createdAt: '2026-01-01T00:00:00Z', ...tokenLifetime(clock), ...over,
  });

  const stored = async (id: string) => (await db.machines.getLocalAgentDevices()).find((candidate) => candidate.id === id);

  beforeEach(async () => {
    db = await make();
    clock = new Date('2026-10-30T12:00:00Z');
    devices = mock<MachineDevices>();
    devices.status.mockReturnValue({ online: false });
    projects = mock<Required<MachineDeps['projects']>>();
    projects.register.mockResolvedValue({ id: 'proj-1' } as never);
    accounts = mock<MachineAccountSide>();
  });

  describe('what My Machines shows of a machine', () => {
    it('lists only the person\'s own machines, with whether each is connected, and never a token', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'mine', lastSeenAt: '2026-10-30T11:00:00Z', os: 'Linux', agentsAt: '2026-10-30T11:00:00Z' }));
      await db.machines.saveLocalAgentDevice(device({ id: 'theirs', ownerId: 'cy' }));
      devices.status.mockImplementation((id) => (id === 'mine' ? { online: true, connectedAt: '2026-10-30T10:00:00Z' } : { online: false }));
      const listed = await service().list('bo');
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: 'mine', online: true, connectedAt: '2026-10-30T10:00:00Z', os: 'Linux', lastSeenAt: '2026-10-30T11:00:00Z', tokenExpired: false, agents: [], manualAgents: [] });
      expect(JSON.stringify(listed)).not.toContain('tokenHash');
    });

    it('shows each machine\'s GPUs and any problem reading them, from the report its cluster keeps, and nothing for one that has not reported', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'rig', name: 'rig' }));
      await db.machines.saveLocalAgentDevice(device({ id: 'old', name: 'old' }));
      const clusters = new MachineClusters({ store: db.infrastructure, dataKey: 'machine-service-key' });
      await clusters.reported({ id: 'rig', ownerId: 'bo', name: 'rig' }, 'stopped', { gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], problems: ['the AMD kernel driver does not answer'] });
      const listed = await service({ clusters }).list('bo');
      expect(listed.find((entry) => entry.id === 'rig')).toMatchObject({ gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], gpuProblems: ['the AMD kernel driver does not answer'] });
      expect(listed.find((entry) => entry.id === 'old')).not.toHaveProperty('gpus');
    });

    it('says a machine\'s token has expired once its time is up', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'old' }));
      clock = new Date(clock.getTime() + 91 * DAY);
      expect((await service().list('bo'))[0]!.tokenExpired).toBe(true);
    });

    it('says where each agent stands against the bundle Koala serves', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'old', lastSeenAt: '2026-10-30T11:00:00Z', agentBundle: A }));
      const served = service({ bundle: { sha256: async () => B } });
      expect((await served.list('bo'))[0]!.agentUpdate).toMatchObject({ state: 'behind', current: B, running: A });
      const plain = service();
      expect((await plain.list('bo'))[0]!.agentUpdate).toBeUndefined();
    });

    it('says which bundle Koala serves, or that it is not known, saying why', async () => {
      expect(await service().currentBundle()).toBeUndefined();
      expect(await service({ bundle: { sha256: async () => A } }).currentBundle()).toBe(A);
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await service({ bundle: { sha256: async () => { throw new Error('no tarball'); } } }).currentBundle()).toBeUndefined();
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('no tarball'));
      warned.mockRestore();
    });

    it('refuses a choice of a machine that is not the person\'s, one without the agent, and one that is not ready or connected', async () => {
      const machines = service();
      await db.machines.saveLocalAgentDevice(device({ id: 'mine', agents: [{ id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found' }, { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found' }] }));
      expect(await machines.choiceProblem('cy', { deviceId: 'mine', agent: 'gemini' })).toBe('that machine is not one of yours any more; pick another on My Machines or in the model list');
      expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'goose' })).toBe('Desk has no agent called goose');
      expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'claude' })).toContain('is not ready');
      expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'gemini' })).toBe('Desk is not connected, so Gemini CLI cannot answer');
      devices.status.mockReturnValue({ online: true });
      expect(await machines.choiceProblem('bo', { deviceId: 'mine', agent: 'gemini' })).toBeUndefined();
    });

    it('records the agents a machine found, as many as are well formed, and when', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
      const machines = service();
      await machines.recordAgents('mine', [
        { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', command: '/usr/bin/gemini', args: ['--acp'], name: 'Gemini CLI', version: '0.61.0' },
        { id: 'Not An Id', title: 'x', state: 'ready', source: 'found' },
      ]);
      const saved = (await stored('mine'))!;
      expect(saved.agents?.map((agent) => agent.id)).toEqual(['gemini']);
      expect(saved.agentsAt).toBe(clock.toISOString());
      await machines.recordAgents('gone', []);
      expect(await stored('gone')).toBeUndefined();
    });

    it('notes when a machine was last connected here', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
      await service().seen('mine');
      expect((await stored('mine'))?.lastSeenAt).toBe(clock.toISOString());
    });

    it('records the bundle an agent runs, forgetting it when the agent names none, and what its self-update reported', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
      const machines = service();
      await machines.recordAgentBundle('mine', { bundle: A });
      expect((await stored('mine'))?.agentBundle).toBe(A);
      await machines.recordAgentBundle('mine', {});
      expect((await stored('mine'))?.agentBundle).toBeUndefined();

      await machines.recordAgentUpdate('mine', { state: 'failed', bundle: B, reason: 'npm ci failed' });
      expect((await stored('mine'))?.agentUpdate).toMatchObject({ state: 'failed', bundle: B, reason: 'npm ci failed', at: clock.toISOString() });
      await machines.recordAgentUpdate('mine', { state: 'nonsense', bundle: B });
      await machines.recordAgentUpdate('mine', null);
      expect((await stored('mine'))?.agentUpdate?.state).toBe('failed');
    });
  });

  describe('the agents added to a machine by hand', () => {
    it('keeps them, tells the machine to look again, and shows them at once', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
      devices.status.mockReturnValue({ online: true });
      const machines = service();
      const outcome = await machines.setManualAgents('bo', 'mine', [{ id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] }]);
      expect(outcome).toMatchObject({ ok: true, value: { manualAgents: [{ id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] }] } });
      expect(devices.tell).toHaveBeenCalledWith('mine', 'agents:changed');
      expect(await machines.manualAgents('mine')).toHaveLength(1);
      expect(await machines.manualAgents('gone')).toEqual([]);
    });

    it('refuses ones it cannot run, and a machine that is not the person\'s', async () => {
      await db.machines.saveLocalAgentDevice(device({ id: 'mine' }));
      const machines = service();
      expect(await machines.setManualAgents('bo', 'mine', [{ id: 'antigravity', command: '' }])).toEqual({ ok: false, status: 400, error: 'antigravity needs the command that starts it' });
      expect(await machines.setManualAgents('bo', 'mine', [{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }])).toMatchObject({ ok: false, status: 400 });
      expect(await machines.setManualAgents('cy', 'mine', [])).toEqual({ ok: false, status: 404, error: 'no such machine' });
      expect(devices.tell).not.toHaveBeenCalled();
    });
  });

  describe('installing an adapter on a machine', () => {
    const waiting = () => device({ id: 'mine', name: 'Adapter', agents: [
      { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@agentclientprotocol/claude-agent-acp' },
      { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found' },
    ] });

    it('asks the machine to install it, and says what the machine answered', async () => {
      await db.machines.saveLocalAgentDevice(waiting());
      devices.status.mockReturnValue({ online: true });
      devices.ask.mockResolvedValue({ ok: true, output: 'added 1 package' });
      expect(await service().installAdapter('bo', 'mine', 'claude')).toEqual({ ok: true, value: { ok: true, output: 'added 1 package' } });
      expect(devices.ask).toHaveBeenCalledWith('mine', 'bo', 'agents:install', { id: 'claude' });
    });

    it('reports a machine that answers with nothing useful as having installed nothing', async () => {
      await db.machines.saveLocalAgentDevice(waiting());
      devices.status.mockReturnValue({ online: true });
      devices.ask.mockResolvedValue(undefined);
      expect(await service().installAdapter('bo', 'mine', 'claude')).toEqual({ ok: true, value: { ok: false, output: '' } });
    });

    it('refuses a machine that is not the person\'s, an agent that needs nothing, and a machine that is not connected', async () => {
      await db.machines.saveLocalAgentDevice(waiting());
      const machines = service();
      expect(await machines.installAdapter('cy', 'mine', 'claude')).toEqual({ ok: false, status: 404, error: 'no such machine' });
      expect(await machines.installAdapter('bo', 'mine', 'gemini')).toEqual({ ok: false, status: 409, error: 'gemini has nothing waiting to be installed on Adapter' });
      expect(await machines.installAdapter('bo', 'mine', 'claude')).toEqual({ ok: false, status: 409, error: 'Adapter is not connected, so nothing can be installed on it' });
      expect(devices.ask).not.toHaveBeenCalled();
    });
  });


  describe('machines come and go through root', () => {
    it('makes the command and removes a machine through the account side', async () => {
      accounts.createJoinCode.calledWith('bo').mockResolvedValue({ code: 'c', command: 'curl root', expiresAt: 'then' });
      accounts.remove.calledWith('bo', 'mine').mockResolvedValue(true);
      expect(await service().createJoinCode('bo')).toEqual({ code: 'c', command: 'curl root', expiresAt: 'then' });
      expect(await service().remove('bo', 'mine')).toBe(true);
    });

    it('makes a machine that arrives its project, and forgets one that leaves: closes its connection, deletes its project and its cluster\'s records, root having told the machine', async () => {
      const machine = { id: 'mine', ownerId: 'bo', name: 'laptop', rootDir: '/home/me/koala', createdAt: '2026-01-01T00:00:00Z' };
      await service().adopt(machine);
      expect(projects.register).toHaveBeenCalledWith('bo', 'laptop - koala', { executionTarget: { kind: 'local-device', deviceId: 'mine' } });
      projects.removeFor.mockResolvedValue(undefined);
      const forgotten: string[] = [];
      const clusters = new MachineClusters({ store: db.infrastructure, dataKey: 'machine-service-key' });
      await clusters.reported({ ...machine, meshIp: '100.64.0.7' }, 'stopped');
      await db.infrastructure.saveDeployment({ id: 'shop', name: 'shop', clusterId: 'machine-mine', ownerId: 'bo', strategy: 'native', status: 'running' });
      const machines = service({ clusters });
      machines.onForgotten((id) => forgotten.push(id));
      await machines.forget(machine);
      expect((await db.infrastructure.getClusters()).some((cluster) => cluster.id === 'machine-mine')).toBe(false);
      expect((await db.infrastructure.getDeployments()).some((app) => app.id === 'shop')).toBe(false);
      expect(devices.tell).not.toHaveBeenCalled();
      expect(devices.drop).toHaveBeenCalledWith('mine');
      expect(forgotten).toEqual(['mine']);
      expect(projects.removeFor).toHaveBeenCalledWith('bo', 'mine');
    });

    it('tells its caller when a machine\'s project or cluster cannot be deleted, rather than calling it forgotten', async () => {
      const gone = { id: 'mine', ownerId: 'bo', name: 'laptop', rootDir: '/x', createdAt: 'then' };
      projects.removeFor.mockRejectedValue(new Error('no project'));
      await expect(service().forget(gone)).rejects.toThrow('no project');
      expect(devices.drop).toHaveBeenCalledWith('mine');
      projects.removeFor.mockResolvedValue(undefined);
      await expect(service({ clusters: { forget: async () => { throw new Error('no cluster'); }, gpuReports: async () => new Map() } }).forget(gone)).rejects.toThrow('no cluster');
    });
  });
}
