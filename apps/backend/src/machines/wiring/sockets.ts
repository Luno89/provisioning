import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import type { Server as SocketServer } from 'socket.io';
import {
  sharedPayloadBlobs, type Database, type Keyring, type SecretKey, type UserMetadata, servesTenants,
  type RoleConfig, ownsProject, type createAuth, signsEveryoneIn,
} from '../../platform/index.js';
import { findDeviceByToken, registerDevice, unregisterDevice } from '../lib/local-agent-registry.js';
import { machinePayloads, type GetAnswer, type PutAnswer, type RingAnswer } from '../lib/machine-payloads.js';
import type { MachineTelemetry, TelemetryAnswer } from '../lib/machine-telemetry.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';
import type { MachineService } from '../services/MachineService.js';
import type { ClusterService, AppService, InfrastructureService } from '../../infrastructure/index.js';

const LOG_TAIL_LINES = 200;

export interface SocketsWiringDeps {
  io: SocketServer;
  db: Database;
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  payloadKey: Keyring;
  dataKey: SecretKey;
  auth: Pick<ReturnType<typeof createAuth>, 'userFromSessionCookie'>;
  machines: Pick<MachineService, 'recordAgents' | 'manualAgents'>;
  clusters: ClusterService;
  apps: AppService;
  infra: InfrastructureService;
  telemetry: MachineTelemetry;
}

export function wireSockets(deps: SocketsWiringDeps): void {
  const { io, db, role, env, payloadKey, dataKey, clusters, apps, infra } = deps;
  io.use(async (socket, next) => {
    if (signsEveryoneIn(env)) {
      const users = await db.accounts.getUsers();
      socket.data.user = users[0] || { id: 'test-user-id', email: 'test@example.com' };
      return next();
    }
    try {
      const user = await deps.auth.userFromSessionCookie(socket.handshake.headers.cookie);
      if (!user) return next(new Error('Unauthorized'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  const agentNamespace = io.of('/agent');
  const forMachines = machinePayloads({ ring: servesTenants(role) ? payloadKey : undefined, blobs: sharedPayloadBlobs() });
  agentNamespace.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Missing device token'));
    const device = findDeviceByToken(await db.machines.getLocalAgentDevices(), token, dataKey);
    if (!device) return next(new Error('Unauthorized'));
    socket.data.device = device;
    next();
  });
  agentNamespace.on('connection', (socket) => {
    const device = socket.data.device as { id: string; ownerId: string; rootDir: string };
    const containerMode = socket.handshake.auth?.containerMode === true;
    registerDevice(device.id, device.ownerId, device.rootDir, socket, containerMode);
    db.machines.getLocalAgentDevices().then((devices) => {
      const current = devices.find((d) => d.id === device.id);
      if (current) db.machines.saveLocalAgentDevice({ ...current, lastSeenAt: new Date().toISOString() }).catch(() => undefined);
    }).catch(() => undefined);
    socket.on('disconnect', () => unregisterDevice(device.id, socket));
    socket.on('agents:found', (report: { agents?: unknown } | undefined) => {
      deps.machines.recordAgents(device.id, report?.agents).catch((err: Error) => console.warn(`[machines] ${device.id}: its agents could not be recorded: ${err.message}`));
    });
    socket.on('agents:manual', (_request: unknown, ack: (agents: unknown) => void) => {
      deps.machines.manualAgents(device.id).then(ack, () => ack([]));
    });
    socket.on('machine:payloads', (_request: unknown, ack: (answer: RingAnswer) => void) => ack(forMachines.ring()));
    socket.on('payloads:put', (request: unknown, ack: (answer: PutAnswer) => void) => { void forMachines.put(request).then(ack); });
    socket.on('payloads:get', (request: unknown, ack: (answer: GetAnswer) => void) => { void forMachines.get(request).then(ack); });
    socket.on('telemetry:export', (request: unknown, ack: (answer: TelemetryAnswer) => void) => { void deps.telemetry.relay(request).then(ack); });
  });

  async function authorizeRoom(user: UserMetadata | undefined, id: string): Promise<any | undefined> {
    if (!user) return undefined;
    const cluster = await clusters.getById(id, user.id);
    if (cluster) return cluster;
    const deployment = await apps.getById(id, user.id);
    if (deployment) return deployment;
    const run = (await db.releases.getPipelineRuns()).find((r: any) => r.id === id);
    if (run) {
      const project = (await db.projects.getProjects()).find((p: any) => p.id === run.projectId);
      const owned = ownsProject(project, user);
      if (owned && run.logFile) return { ...run, lastLogPath: run.logFile };
    }
    return undefined;
  }

  io.on('connection', (socket) => {
    const connectedUser = (socket.data.user as { id?: string } | undefined)?.id;
    if (connectedUser) void socket.join(userRoom(connectedUser));
    const socketTails = new Map<string, any>();

    socket.on('join-room', async (id) => {
      const resource = await authorizeRoom(socket.data.user, id);
      if (!resource) {
        socket.emit('room-denied', { id });
        return;
      }
      socket.join(id);

      const existing = socketTails.get(id);
      if (existing) {
        existing.kill();
        socketTails.delete(id);
      }

      if (resource.lastLogPath) {
        try {
          await fs.access(resource.lastLogPath);
        } catch {
          await fs.mkdir(path.dirname(resource.lastLogPath), { recursive: true }).catch(() => {});
          await fs.writeFile(resource.lastLogPath, '').catch(() => {});
        }

        const tail = spawn('tail', ['-n', String(LOG_TAIL_LINES), '-f', resource.lastLogPath]);
        socketTails.set(id, tail);

        tail.stdout.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.stderr.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.on('error', (err) => {
          console.warn(`[log-tail] ${resource.lastLogPath}: ${err.message}`);
          socketTails.delete(id);
        });

        tail.on('close', () => {
          socketTails.delete(id);
        });
      }
    });

    socket.on('join-kube-room', async (id) => {
      if (!(await authorizeRoom(socket.data.user, id))) {
        socket.emit('room-denied', { id });
        return;
      }
      socket.join(`${id}-kube`);
    });
    socket.on('tail-pod', async ({ resourceId, podName, namespace }) => {
      const user = socket.data.user as UserMetadata | undefined;
      if (!user) return;
      const dep = await apps.getById(resourceId, user.id);
      if (!dep) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      const cluster = dep.clusterId === 'provisioning-lunorica'
        ? await clusters.getSystemClusterEntry()
        : await clusters.getById(dep.clusterId, user.id);
      if (!cluster) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      let context: string | undefined;
      const isMock = clusters.isMockCloud(cluster);
      const physicalName = clusters.getPhysicalClusterName(cluster);
      if (cluster.provider === 'k3d' || isMock) context = `k3d-${physicalName}`;
      const kubeconfigPath = await clusters.getKubeconfigPath(cluster);
      const args = ['logs', '-n', namespace || 'default', podName, '--all-containers=true', '--tail=100', '-f'];
      if (context) args.push('--context', context);
      infra.streamLogs(resourceId, args, io, `${resourceId}-kube`, kubeconfigPath);
    });

    socket.on('leave-room', (id) => {
      socket.leave(id);
      const tail = socketTails.get(id);
      if (tail) {
        tail.kill();
        socketTails.delete(id);
      }
    });

    socket.on('leave-kube-room', (id) => { socket.leave(`${id}-kube`); infra.stopStream(id); });

    socket.on('disconnect', () => {
      for (const tail of socketTails.values()) {
        tail.kill();
      }
      socketTails.clear();
    });
  });

}
