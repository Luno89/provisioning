import fs from 'fs/promises';
import path from 'path';
import type { Server as SocketServer } from 'socket.io';
import {
  type PayloadBlobs, type Database, type Keyring, type SecretKey, type UserMetadata, servesTenants,
  type RoleConfig, allowed, type Principal, type createAuth, signSocketsIn, type SignedInSockets, type SessionSockets, nodeStreams, type Followed, type Streams,
} from '../../platform/index.js';
import { registerDevice, unregisterDevice } from '../lib/local-agent-registry.js';
import { MACHINE_CLIENT_TOKEN } from '@koala/engine-core/machine-join';
import { machinePayloads, type GetAnswer, type MachineTemporal, type PutAnswer, type RingAnswer } from '../lib/machine-payloads.js';
import type { MachineTelemetry, TelemetryAnswer } from '../lib/machine-telemetry.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';
import type { MachineService } from '../services/MachineService.js';
import { MachineRunWatch, type RunLiveness } from '../services/MachineRunWatch.js';
import { podLogTarget, PodLogTails, type ClusterService, type AppService } from '../../infrastructure/index.js';
import type { MachineClusters } from '../services/MachineClusters.js';
import { reportedCluster } from '../lib/machine-clusters.js';
import { machineAdmission, type MachineAdmission, type MachineTokens } from './machine-admission.js';

const LOG_TAIL_LINES = 200;

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
  payloadBlobs: PayloadBlobs;
  payloadKey: Keyring;
  dataKey: SecretKey;
  auth: Pick<ReturnType<typeof createAuth>, 'sessionOf' | 'sessionHandle' | 'principalFor'>;
  sessionSockets: Pick<SessionSockets, 'track' | 'forget'>;
  machines: Pick<MachineService, 'seen' | 'recordAgents' | 'manualAgents' | 'recordAgentBundle' | 'recordAgentUpdate' | 'currentBundle'>;
  machineTokens?: MachineTokens | undefined;
  machineClusters?: Pick<MachineClusters, 'reported'> | undefined;
  clusters: ClusterService;
  apps: AppService;
  telemetry: MachineTelemetry;
  machineTemporal?: MachineTemporal | undefined;
  runs?: RunLiveness | undefined;
  now?: (() => Date) | undefined;
  streams?: Streams | undefined;
}

export function wireSockets(deps: SocketsWiringDeps): SignedInSockets {
  const { io, db, role, payloadKey, clusters, apps } = deps;
  const streams = deps.streams ?? nodeStreams;
  const podLogs = new PodLogTails({ access: clusters.access, say: (room, text) => io.to(room).emit('kube-log', text), log: (message) => console.warn(message) });
  const signedIn = signSocketsIn(io, { auth: deps.auth, sessionSockets: deps.sessionSockets });

  const agentNamespace = io.of('/agent');
  const admitted = new WeakMap<object, MachineAdmission>();
  const forMachines = machinePayloads({ ring: servesTenants(role) ? payloadKey : undefined, blobs: deps.payloadBlobs, ...(deps.machineTemporal ? { temporal: deps.machineTemporal } : {}) });
  const now = deps.now ?? (() => new Date());
  const ownerId = role.instance?.ownerId;
  const admit = deps.machineTokens ? machineAdmission(db, deps.machineTokens, ownerId) : undefined;
  agentNamespace.use((socket, next) => {
    const auth: Record<string, unknown> | undefined = socket.handshake.auth;
    const token = tokenOf(auth);
    if (!token) return next(new Error('Unauthorized: send a token root gave this machine for this Koala'));
    if (!admit) return next(new Error('this Koala takes no machines'));
    admit(token).then((admission) => {
      if (typeof admission === 'string') return next(new Error(admission));
      admitted.set(socket, admission);
      return next();
    }, (err: Error) => next(new Error(`Koala could not look up this machine just now (${err.message}); it connects again by itself`)));
  });
  const runWatch = deps.runs ? new MachineRunWatch(deps.runs) : undefined;
  agentNamespace.on('connection', (socket) => {
    const machine = admitted.get(socket);
    const tokens = deps.machineTokens;
    if (!machine || !tokens) {
      socket.disconnect(true);
      return;
    }
    const { device } = machine;
    let { until } = machine;
    let checked = Promise.resolve();
    socket.use((packet, next) => {
      checked = checked.then(async () => {
        if (packet[0] === MACHINE_CLIENT_TOKEN) {
          const fresh = await tokens.checkMachineToken(tokenOf(packet[1] as Record<string, unknown> | undefined) ?? '');
          if (typeof fresh === 'string' || fresh.deviceId !== device.id) return void socket.disconnect(true);
          until = fresh.until;
          return;
        }
        if (now().getTime() >= until) return void socket.disconnect(true);
        next();
      }).catch((err: Error) => {
        console.warn(`[machines] ${device.id}: what it sent could not be checked (${err.message}); it is cut off and connects again by itself`);
        socket.disconnect(true);
      });
    });
    const tellRunEnded = (runId: string) => { if (socket.connected) socket.emit('machine:run-ended', { runId }); };
    const auth: Record<string, unknown> | undefined = socket.handshake.auth;
    registerDevice(device.id, device.ownerId, device.rootDir, socket);
    deps.machines.seen(device.id).catch((err: Error) => console.warn(`[machines] ${device.id}: when it was last seen could not be recorded: ${err.message}`));
    deps.machines.recordAgentBundle(device.id, auth).catch((err: Error) => console.warn(`[machines] ${device.id}: which agent it runs could not be recorded: ${err.message}`));
    deps.machines.currentBundle().then((sha256) => { if (sha256 && socket.connected) socket.emit('machine:bundle', { sha256 }); }, (err: Error) => console.warn(`[machines] ${device.id}: the agent it should run could not be named: ${err.message}`));
    socket.on('disconnect', () => {
      unregisterDevice(device.id, socket);
      runWatch?.forget(device.id, tellRunEnded);
    });
    socket.on('machine:runs', (report: unknown) => runWatch?.follow(device.id, device.ownerId, report, tellRunEnded));
    let reports = Promise.resolve();
    const inTurn = (record: () => Promise<unknown>, what: string): void => {
      reports = reports.then(record).then(() => undefined, (err: Error) => console.warn(`[machines] ${device.id}: ${what} could not be recorded: ${err.message}`));
    };
    socket.on('machine:cluster', (report: unknown) => {
      const reported = reportedCluster(report);
      const clusters = deps.machineClusters;
      if (!reported || !clusters) return;
      inTurn(() => clusters.reported(device, reported.state, reported.gpus, reported.capacity), 'whether it has its own cluster');
    });
    socket.on('agents:found', (report: unknown) => {
      inTurn(() => deps.machines.recordAgents(device.id, report), 'its agents');
    });
    socket.on('machine:update', (report: unknown) => {
      inTurn(() => deps.machines.recordAgentUpdate(device.id, report), 'how its agent\'s update goes');
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
    const socketTails = new Map<string, Followed>();

    const joinRoom = async (id: unknown) => {
      const resource = await authorizeRoom(user, id);
      if (typeof id !== 'string' || !resource) {
        socket.emit('room-denied', { id });
        return;
      }
      void socket.join(id);

      const existing = socketTails.get(id);
      if (existing) {
        existing.stop('SIGTERM');
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

        const said = (chunk: string): void => { socket.emit('log', chunk); };
        const tail = streams.start({ command: 'tail', args: ['-n', String(LOG_TAIL_LINES), '-f', logPath] }, { heard: { stdout: said, stderr: said } });
        socketTails.set(id, tail);
        const forget = (): void => { if (socketTails.get(id) === tail) socketTails.delete(id); };
        tail.ended.then(forget, (err: Error) => {
          console.warn(`[log-tail] ${logPath}: ${err.message}`);
          forget();
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
      await podLogs.tail({ resourceId, clusterId: cluster.id, namespace: target.namespace, podName: target.podName });
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
        tail.stop('SIGTERM');
        socketTails.delete(id);
      }
    });

    socket.on('leave-kube-room', (id: unknown) => {
      if (typeof id !== 'string') return;
      void socket.leave(`${id}-kube`);
      podLogs.stop(id);
    });

    socket.on('disconnect', () => {
      for (const tail of socketTails.values()) {
        tail.stop('SIGTERM');
      }
      socketTails.clear();
    });
  });
  return signedIn;
}
