import type { Socket } from 'socket.io-client';
import { createMachineGit } from './machine-git.js';
import { engineSettingsOver, remoteBlobs } from './remote-blobs.js';
import { DeviceWorkerHost } from './device-worker-host.js';
import { machineClusterOp, type MachineHost } from './machine-cluster.js';
import type { MachineConfig } from './machine-config.js';
import type { ExternalAgentSessions } from './external-agents.js';
import type { IdleGate } from './idle-gate.js';
import type { DeviceWorker, DeviceWorkerOptions } from './engine-worker.js';

export interface WorkToken {
  value: string;
}

export interface KoalaReach {
  url: string;
  token(): Promise<string>;
}

export function followEngineWorker(socket: Socket, config: MachineConfig, koala: KoalaReach, work: WorkToken, sessions: ExternalAgentSessions, gate: IdleGate, machineCluster: MachineHost, startDeviceWorker: (options: DeviceWorkerOptions) => Promise<DeviceWorker>): DeviceWorkerHost | undefined {
  if (!config.deviceId) return undefined;
  const { deviceId } = config;
  const host = new DeviceWorkerHost(async (settings) => {
    if (!settings.temporal) throw new Error('Koala named no Temporal for this machine to take work from');
    const { address, namespace, ca, serverName } = settings.temporal;
    return startDeviceWorker({
      rootDir: config.rootDir,
      deviceId,
      externalAgents: sessions,
      git: createMachineGit({ rootDir: config.rootDir, backendUrl: koala.url, token: () => koala.token() }),
      cluster: (op) => machineClusterOp(machineCluster, op),
      address,
      tls: { ca, serverName },
      token: work.value,
      payloads: { ring: settings.ring, blobs: remoteBlobs(socket) },
      gate,
      namespace,
      onReady: (queue) => console.log(`[koala-local-agent] engine worker polling ${queue} at ${address}`),
    });
  });
  socket.on('connect', () => { void host.connected(() => engineSettingsOver(socket)); });
  return host;
}
