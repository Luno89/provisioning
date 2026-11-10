import type { Socket } from 'socket.io-client';
import { createMachineGit } from './machine-git.js';
import { engineSettingsOver, remoteBlobs } from './remote-blobs.js';
import { DeviceWorkerHost } from './device-worker-host.js';
import { runMachineCluster, type ClusterHost } from './machine-cluster.js';
import type { MachineConfig } from './machine-config.js';
import type { ExternalAgentSessions } from './external-agents.js';
import type { IdleGate } from './idle-gate.js';
import type { DeviceWorker, DeviceWorkerOptions } from './engine-worker.js';

export interface WorkToken {
  value: string;
}

export function followEngineWorker(socket: Socket, config: MachineConfig, koalaUrl: string, work: WorkToken, sessions: ExternalAgentSessions, gate: IdleGate, machineCluster: ClusterHost, startDeviceWorker: (options: DeviceWorkerOptions) => Promise<DeviceWorker>): DeviceWorkerHost | undefined {
  if (!config.deviceId) return undefined;
  const { deviceId } = config;
  const host = new DeviceWorkerHost(async (settings) => {
    const address = settings.temporal?.address;
    const namespace = settings.temporal?.namespace;
    if (!address) throw new Error('Koala named no Temporal for this machine to take work from');
    return startDeviceWorker({
      rootDir: config.rootDir,
      deviceId,
      externalAgents: sessions,
      git: createMachineGit({ rootDir: config.rootDir, backendUrl: koalaUrl, token: () => work.value }),
      cluster: (op) => runMachineCluster(machineCluster, op),
      address,
      token: work.value,
      payloads: { ring: settings.ring, blobs: remoteBlobs(socket) },
      gate,
      ...(namespace ? { namespace } : {}),
      onReady: (queue) => console.log(`[koala-local-agent] engine worker polling ${queue} at ${address}`),
    });
  });
  socket.on('connect', () => { void host.connected(() => engineSettingsOver(socket)); });
  return host;
}
