import fs from 'fs/promises';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { Server as SocketServer } from 'socket.io';
import {
  sharedPayloadBlobs, type Database, type Keyring, type SecretKey, type UserMetadata, type LocalAgentDeviceMetadata, servesTenants,
  type RoleConfig, allowed, type Principal, type createAuth, signSocketsIn, type SessionSockets,
} from '../../platform/index.js';
import { matchDeviceToken, registerDevice, unregisterDevice } from '../lib/local-agent-registry.js';
import { TOKEN_EXPIRED_SAID, type TokenVia } from '../lib/device-tokens.js';
import { rotateDeviceToken } from '../lib/device-rotation.js';
import { machinePayloads, type GetAnswer, type PutAnswer, type RingAnswer } from '../lib/machine-payloads.js';
import type { MachineTelemetry, TelemetryAnswer } from '../lib/machine-telemetry.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';
import type { MachineService } from '../services/MachineService.js';
import { MachineRunWatch, type RunLiveness } from '../services/MachineRunWatch.js';
import { podLogTarget, type ClusterService, type AppService, type InfrastructureService } from '../../infrastructure/index.js';

const LOG_TAIL_LINES = 200;

interface MachineSocketData {
  device: LocalAgentDeviceMetadata;
  via: TokenVia;
}

const signedInUser = (data: unknown): UserMetadata | undefined => {
  if (!data || typeof data !== 'object' || !('user' in data)) return undefined;
  const { user } = data;
  if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !('email' in user) || typeof user.email !== 'string') return undefined;
  return user as UserMetadata;
};

interface PodAsked {
  resourceId?: unknown;
  podName?: unknown;
  namespace?: unknown;
}

const tokenOf = (auth: Record<string, unknown> | undefined): string | undefined => (typeof auth?.token === 'string' && auth.token ? auth.token : undefined);

export interface SocketsWiringDeps {
  io: SocketServer;
  db: Database;
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  payloadKey: Keyring;
  dataKey: SecretKey;
  auth: Pick<ReturnType<typeof createAuth>, 'sessionFromCookie' | 'securedFor' | 'principalFor'>;
  sessionSockets: Pick<SessionSockets, 'track' | 'forget'>;
  machines: Pick<MachineService, 'seen' | 'recordAgents' | 'manualAgents' | 'recordMeshIp' | 'rotationFor' | 'tokenTaken' | 'recordAgentBundle' | 'recordAgentUpdate' | 'currentBundle'>;
  clusters: ClusterService;
  apps: AppService;
  infra: InfrastructureService;
  telemetry: MachineTelemetry;
  machineTemporal?: { address: string; namespace: string } | undefined;
  runs?: RunLiveness | undefined;
  now?: (() => Date) | undefined;
}

export function wireSockets(deps: SocketsWiringDeps): void {
  const { io, db, role, env, payloadKey, dataKey, clusters, apps, infra } = deps;
  signSocketsIn(io, { auth: deps.auth, db, env, sessionSockets: deps.sessionSockets });

  const agentNamespace = io.of('/agent');
  const admitted = new WeakMap<object, MachineSocketData>();
  const forMachines = machinePayloads({ ring: servesTenants(role) ? payloadKey : undefined, blobs: sharedPayloadBlobs(), ...(deps.machineTemporal ? { temporal: deps.machineTemporal } : {}) });
  agentNamespace.use((socket, next) => {
    const auth: Record<string, unknown> | undefined = socket.handshake.auth;
    const token = tokenOf(auth);
    if (!token) return next(new Error('Missing device token'));
    db.machines.getLocalAgentDevices().then((devices) => {
      const match = matchDeviceToken(devices, token, dataKey, (deps.now ?? (() => new Date()))());
      if (!match) return next(new Error('Unauthorized'));
      if (match.expired) return next(new Error(TOKEN_EXPIRED_SAID));
      admitted.set(socket, { device: match.device, via: match.via });
      return next();
    }, (err: Error) => next(new Error(`Koala could not look up this machine just now (${err.message}); it connects again by itself`)));
  });
  const runWatch = deps.runs ? new MachineRunWatch(deps.runs) : undefined;
  agentNamespace.on('connection', (socket) => {
    const machine = admitted.get(socket);
    if (!machine) {
      socket.disconnect(true);
      return;
    }
    const { device, via } = machine;
    const tellRunEnded = (runId: string) => { if (socket.connected) socket.emit('machine:run-ended', { runId }); };
    const auth: Record<string, unknown> | undefined = socket.handshake.auth;
    const containerMode = auth?.containerMode === true;
    registerDevice(device.id, device.ownerId, device.rootDir, socket, containerMode);
    deps.machines.seen(device.id).catch((err: Error) => console.warn(`[machines] ${device.id}: when it was last seen could not be recorded: ${err.message}`));
    deps.machines.recordAgentBundle(device.id, auth).catch((err: Error) => console.warn(`[machines] ${device.id}: which agent it runs could not be recorded: ${err.message}`));
    deps.machines.currentBundle().then((sha256) => { if (sha256 && socket.connected) socket.emit('machine:bundle', { sha256 }); }, (err: Error) => console.warn(`[machines] ${device.id}: the agent it should run could not be named: ${err.message}`));
    void rotateDeviceToken(socket, device.id, via, deps.machines)
      .catch((err: Error) => console.warn(`[machines] ${device.id}: its token could not be rotated: ${err.message}`));
    socket.on('disconnect', () => {
      unregisterDevice(device.id, socket);
      runWatch?.forget(device.id, tellRunEnded);
    });
    socket.on('machine:runs', (report: unknown) => runWatch?.follow(device.id, device.ownerId, report, tellRunEnded));
    socket.on('agents:found', (report: { agents?: unknown } | undefined) => {
      deps.machines.recordAgents(device.id, report?.agents).catch((err: Error) => console.warn(`[machines] ${device.id}: its agents could not be recorded: ${err.message}`));
    });
    socket.on('machine:update', (report: unknown) => {
      deps.machines.recordAgentUpdate(device.id, report).catch((err: Error) => console.warn(`[machines] ${device.id}: how its agent's update goes could not be recorded: ${err.message}`));
    });
    socket.on('machine:mesh', (report: { ip?: unknown } | undefined) => {
      deps.machines.recordMeshIp(device.id, report?.ip).catch((err: Error) => console.warn(`[machines] ${device.id}: its mesh address could not be recorded: ${err.message}`));
    });
    socket.on('agents:manual', (_request: unknown, ack: (agents: unknown) => void) => {
      deps.machines.manualAgents(device.id).then(ack, (err: Error) => {
        console.warn(`[machines] ${device.id}: the agents added to it by hand could not be read, so it is told of none this time: ${err.message}`);
        ack([]);
      });
    });
    socket.on('machine:payloads', (_request: unknown, ack: (answer: RingAnswer) => void) => ack(forMachines.ring()));
    socket.on('payloads:put', (request: unknown, ack: (answer: PutAnswer) => void) => { void forMachines.put(device.id, request).then(ack); });
    socket.on('payloads:get', (request: unknown, ack: (answer: GetAnswer) => void) => { void forMachines.get(device.id, request).then(ack); });
    socket.on('telemetry:export', (request: unknown, ack: (answer: TelemetryAnswer) => void) => { void deps.telemetry.relay(request).then(ack); });
  });

  const principalOfSocket = (user: UserMetadata | undefined): Principal | undefined => (user ? deps.auth.principalFor(user) : undefined);

  async function authorizeRoom(user: UserMetadata | undefined, id: unknown): Promise<{ lastLogPath?: string | undefined } | undefined> {
    if (typeof id !== 'string') return undefined;
    const principal = principalOfSocket(user);
    if (!principal) return undefined;
    const cluster = await clusters.getById(id, principal, 'see-everything');
    if (cluster) return cluster;
    const deployment = await apps.getById(id, principal.id);
    if (deployment) return deployment;
    const run = (await db.releases.getPipelineRuns()).find((r) => r.id === id);
    if (run) {
      const project = (await db.projects.getProjects()).find((p) => p.id === run.projectId);
      const owned = project !== undefined && allowed(principal, 'see', { kind: 'project', ownerId: project.ownerId });
      if (owned && run.logFile) return { ...run, lastLogPath: run.logFile };
    }
    return undefined;
  }

  io.on('connection', (socket) => {
    const data: unknown = socket.data;
    const user = signedInUser(data);
    const connectedUser = user?.id;
    if (connectedUser) void socket.join(userRoom(connectedUser));
    const socketTails = new Map<string, ChildProcessWithoutNullStreams>();

    const joinRoom = async (id: unknown) => {
      const resource = await authorizeRoom(user, id);
      if (typeof id !== 'string' || !resource) {
        socket.emit('room-denied', { id });
        return;
      }
      void socket.join(id);

      const existing = socketTails.get(id);
      if (existing) {
        existing.kill();
        socketTails.delete(id);
      }

      if (resource.lastLogPath) {
        const logPath = resource.lastLogPath;
        try {
          await fs.access(logPath);
        } catch {
          try {
            await fs.mkdir(path.dirname(logPath), { recursive: true });
            await fs.writeFile(logPath, '');
          } catch (err) {
            console.warn(`[log-tail] ${logPath} could not be made to follow: ${(err as Error).message}`);
          }
        }

        const tail = spawn('tail', ['-n', String(LOG_TAIL_LINES), '-f', logPath]);
        socketTails.set(id, tail);

        tail.stdout.on('data', (data: Buffer) => {
          socket.emit('log', data.toString());
        });

        tail.stderr.on('data', (data: Buffer) => {
          socket.emit('log', data.toString());
        });

        tail.on('error', (err) => {
          console.warn(`[log-tail] ${logPath}: ${err.message}`);
          socketTails.delete(id);
        });

        tail.on('close', () => {
          socketTails.delete(id);
        });
      }
    };

    const joinKubeRoom = async (id: unknown) => {
      if (typeof id !== 'string' || !(await authorizeRoom(user, id))) {
        socket.emit('room-denied', { id });
        return;
      }
      void socket.join(`${id}-kube`);
    };

    const tailPod = async (asked: PodAsked | undefined) => {
      const { resourceId, podName, namespace } = asked ?? {};
      if (!user) return;
      if (typeof resourceId !== 'string') {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      const dep = await apps.getById(resourceId, user.id);
      const target = dep ? podLogTarget(dep, { podName, namespace }) : undefined;
      if (!dep || !target) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      const cluster = await clusters.getById(dep.clusterId, deps.auth.principalFor(user));
      if (!cluster) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      let context: string | undefined;
      const isMock = clusters.isMockCloud(cluster);
      const physicalName = clusters.getPhysicalClusterName(cluster);
      if (cluster.provider === 'k3d' || isMock) context = `k3d-${physicalName}`;
      const kubeconfigPath = await clusters.getKubeconfigPath(cluster);
      const args = ['logs', '-n', target.namespace, target.podName, '--all-containers=true', '--tail=100', '-f'];
      if (context) args.push('--context', context);
      await infra.streamLogs(resourceId, args, io, `${resourceId}-kube`, kubeconfigPath);
    };

    const refusedRoom = (event: string) => (err: Error) => console.warn(`[sockets] ${connectedUser ?? 'someone'}'s ${event} could not be answered: ${err.message}`);
    socket.on('join-room', (id: unknown) => { joinRoom(id).catch(refusedRoom('join-room')); });
    socket.on('join-kube-room', (id: unknown) => { joinKubeRoom(id).catch(refusedRoom('join-kube-room')); });
    socket.on('tail-pod', (asked: PodAsked | undefined) => { tailPod(asked).catch(refusedRoom('tail-pod')); });

    socket.on('leave-room', (id: unknown) => {
      if (typeof id !== 'string') return;
      void socket.leave(id);
      const tail = socketTails.get(id);
      if (tail) {
        tail.kill();
        socketTails.delete(id);
      }
    });

    socket.on('leave-kube-room', (id: unknown) => {
      if (typeof id !== 'string') return;
      void socket.leave(`${id}-kube`);
      infra.stopStream(id);
    });

    socket.on('disconnect', () => {
      for (const tail of socketTails.values()) {
        tail.kill();
      }
      socketTails.clear();
    });
  });

}
