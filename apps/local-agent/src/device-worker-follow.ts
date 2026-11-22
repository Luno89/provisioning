import type { Socket } from 'socket.io-client';
import { createMachineGit } from './machine-git.js';
import { engineSettingsOver, remoteBlobs } from './remote-blobs.js';
import { DeviceWorkerHost } from './device-worker-host.js';
import { machineClusterOp, type MachineHost } from './machine-cluster.js';
import type { MachineConfig } from './machine-config.js';
import type { ExternalAgentSessions } from './external-agents.js';
import type { IdleGate } from './idle-gate.js';
import type { DeviceWorker, DeviceWorkerOptions } from './engine-worker.js';
import { keepTokenFresh, type KoalaAccess } from './koala-access.js';

export interface KoalaReach {
  url: string;
  resource: string;
  access: KoalaAccess;
}

const say = (line: string) => console.log(`[koala-local-agent] ${line}`);

export function followEngineWorker(socket: Socket, config: MachineConfig, koala: KoalaReach, sessions: ExternalAgentSessions, gate: IdleGate, machineCluster: MachineHost, startDeviceWorker: (options: DeviceWorkerOptions) => Promise<DeviceWorker>): DeviceWorkerHost | undefined {
  if (!config.deviceId) return undefined;
  const { deviceId } = config;
  const { access, resource } = koala;
  const host = new DeviceWorkerHost(async (settings) => {
    if (!settings.temporal) throw new Error('Koala named no Temporal for this machine to take work from');
    const { address, namespace, ca, serverName } = settings.temporal;
    const worker = await startDeviceWorker({
      rootDir: config.rootDir,
      deviceId,
      externalAgents: sessions,
      git: createMachineGit({ rootDir: config.rootDir, backendUrl: koala.url, token: () => access.token(resource) }),
      cluster: (op) => machineClusterOp(machineCluster, op),
      address,
      tls: { ca, serverName },
      token: await access.token(resource),
      payloads: { ring: settings.ring, blobs: remoteBlobs(socket) },
      gate,
      namespace,
      onReady: (queue) => console.log(`[koala-local-agent] engine worker polling ${queue} at ${address}`),
    });
    const stop = keepTokenFresh({ access, resource, apply: (token) => worker.setToken(token), say });
    return {
      run: () => worker.run().finally(stop),
      shutdown: () => {
        stop();
        worker.shutdown();
      },
    };
  });
  socket.on('connect', () => { void host.connected(() => engineSettingsOver(socket)); });
  return host;
}
