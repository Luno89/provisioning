import { testKeys } from '../../platform/testing/keys.js';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LSPCI_QUERY } from '@koala/engine-core';
import { clusterOnConnect, K3S_MARKER, type ClusterHost } from '../../../../local-agent/src/machine-cluster.js';
import { machineCapacity } from '../../../../local-agent/src/machine-capacity.js';
import { machineGpus, NVIDIA_CDI_HOOK, NVIDIA_RUNTIME } from '../../../../local-agent/src/machine-gpus.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { machineSignInKey } from '../../instances/testing/registration-code.js';
import { MachineClusters } from '../services/MachineClusters.js';
import type { MachineService } from '../services/MachineService.js';
import { agentAccess, servedAgentSockets, until, onlineMachines, type AgentAccess } from '../testing/wiring-world.js';

const fresh = await emptiedEachTime();
const keys = testKeys('machine-cluster-reports-secret');

let db: MongoDB;
let access: AgentAccess;
let koala: Awaited<ReturnType<typeof servedAgentSockets>>;
let url = '';
const clients: ClientSocket[] = [];

const machineWith = (installed: boolean): MockProxy<ClusterHost> => {
  const host = mock<ClusterHost>({ platform: 'linux' });
  host.exists.mockImplementation(async (path) => installed && path === K3S_MARKER);
  host.isWanted.mockResolvedValue(false);
  host.run.mockResolvedValue('inactive\n');
  return host;
};

async function reports(host: ClusterHost, withGpus = false): Promise<void> {
  const socket = connect(`${url}/agent`, { auth: { token: await access.token('desk') }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
  const state = await clusterOnConnect(host, () => undefined);
  if (!withGpus) {
    socket.emit('machine:cluster', { state });
    return;
  }
  const gpus = await machineGpus(host);
  socket.emit('machine:cluster', { state, ...gpus, capacity: machineCapacity({ cpus: () => 16, totalMemory: () => 64 * 1024 ** 3 }) });
}

const NOUVEAU_3090 = 'Slot:\t01:00.0\nClass:\tVGA compatible controller [0300]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tGA102 [GeForce RTX 3090] [2204]\nDriver:\tnouveau\n';

const withADriverlessNvidiaCard = (host: MockProxy<ClusterHost>): ClusterHost => {
  host.run.mockImplementation(async (file, args) => {
    if (file === 'nvidia-smi') throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    if (file === 'lspci' && args.join(' ') === LSPCI_QUERY.join(' ')) return NOUVEAU_3090;
    return 'inactive\n';
  });
  return host;
};

const withTwoNvidiaCards = (host: MockProxy<ClusterHost>): ClusterHost => {
  host.run.mockImplementation(async (file) => (file === 'nvidia-smi' ? 'NVIDIA GeForce RTX 3090, 24576\nNVIDIA GeForce RTX 3090, 24576\n' : 'inactive\n'));
  host.exists.mockImplementation(async (path) => path === K3S_MARKER || path === NVIDIA_CDI_HOOK || path === NVIDIA_RUNTIME);
  return host;
};

let machines: MachineService;

const desk = async () => (await db.infrastructure.getClusters()).find((cluster) => cluster.id === 'machine-desk');

beforeEach(async () => {
  db = await fresh();
  const machineClusters = new MachineClusters({ store: db.infrastructure, accounts: db.accounts, dataKey: keys.data, io: { to: () => ({ emit: () => true }) } });
  machines = onlineMachines(db.machines, { clusters: machineClusters });
  await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/home/person/koala', meshIp: '100.64.0.7', createdAt: new Date().toISOString(), signIn: machineSignInKey() });
  access = await agentAccess(db);
  koala = await servedAgentSockets({ db, payloadKey: keys.payload, dataKey: keys.data, machines, machineTokens: access.machineTokens, machineClusters });
  url = koala.url;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await koala.close();
});

describe('a machine telling Koala about its own cluster', () => {
  it('a machine whose k3s Koala installed shows its cluster, stopped, on its mesh address', async () => {
    await reports(machineWith(true));
    expect(await until(desk)).toMatchObject({ provider: 'machine', status: 'stopped', machineId: 'desk', ownerId: 'owner-1', meshIp: '100.64.0.7' });
  });

  it('a machine reporting its GPUs and its size again keeps them on its cluster, read by the agent\'s own readers', async () => {
    await reports(machineWith(true));
    await until(desk);
    await reports(withTwoNvidiaCards(machineWith(true)), true);
    const reported = await until(async () => ((await desk())?.gpus ? desk() : undefined));
    expect(reported).toMatchObject({ gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }], gpuProblems: [] });
    expect(reported?.capacity).toEqual({ cpuCores: 16, ramGb: 64, gpuCount: 2, gpuVendor: 'nvidia' });
  });

  it('a machine with an NVIDIA card whose driver is not installed shows it so on My Machines, read by the agent\'s own reader', async () => {
    await reports(withADriverlessNvidiaCard(machineWith(true)), true);
    const listed = await until(async () => (await machines.list('owner-1')).find((machine) => machine.id === 'desk' && machine.gpus));
    expect(listed).toMatchObject({ gpus: [], gpuProblems: [], gpusWithoutDriver: [{ vendor: 'nvidia', device: 'GA102 [GeForce RTX 3090]', count: 1 }] });
  });

  it('a machine whose k3s is gone takes its cluster with it once no app is on it', async () => {
    await reports(machineWith(true));
    await until(desk);
    await reports(machineWith(false));
    await until(async () => ((await desk()) ? undefined : true));
    expect(await desk()).toBeUndefined();
  });
});
