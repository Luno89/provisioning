import type { Socket } from 'socket.io-client';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { connectAgainIfRefused, koalaSocket, type KoalaAccess } from './koala-access.js';
import type { Koala } from './root-link.js';
import {
  runCommand, readLocalFile, writeLocalFile, listLocalDir, deleteLocalFile, type ExecResult,
} from './sandbox-handlers.js';
import type { MachineConfig } from './machine-config.js';
import { KNOWN_AGENTS, manualAnswerOf, reportAgents, type DiscoveryDeps, type ManualAgent } from './agent-discovery.js';
import { installAgent } from './agent-install.js';
import { ExternalAgentSessions } from './external-agents.js';
import { LocalMcpServer } from './local-mcp.js';
import type { DeviceWorkerHost } from './device-worker-host.js';
import { followEngineWorker } from './device-worker-follow.js';
import { clusterOnConnect, type MachineHost } from './machine-cluster.js';
import { socketSink } from './telemetry-sink.js';
import { IdleGate, holding } from './idle-gate.js';
import { SelfUpdate, type serviceManagerOf, type UpdateReport } from './self-update.js';
import { discardBundle, placeOf, prepareBundle, swapBundle } from './agent-bundle.js';
import type { DeviceWorker, DeviceWorkerOptions } from './engine-worker.js';
import { machineCapacity } from './machine-capacity.js';
import { machineGpus } from './machine-gpus.js';

export interface AgentPlace {
  agentDir: string;
  ownBundle: string | undefined;
  service: ReturnType<typeof serviceManagerOf>;
  cluster: MachineHost;
  discovery(rootDir: string): DiscoveryDeps;
  agentsNotSetUp(): Promise<string | undefined>;
  startDeviceWorker(options: DeviceWorkerOptions): Promise<DeviceWorker>;
  onStop(stop: () => void): void;
  exit(code: number): void;
}

const say = (line: string) => console.log(`[koala-local-agent] ${line}`);


const manualOver = (socket: Socket) => new Promise<ManualAgent[]>((resolve, reject) => {
  socket.emit('agents:manual', {}, (answer: unknown) => {
    try {
      resolve(manualAnswerOf(answer));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
});

function watchAgents(place: AgentPlace, socket: Socket, config: MachineConfig, sessions: ExternalAgentSessions, gate: IdleGate): void {
  const deps = place.discovery(config.rootDir);
  const rediscover = (): Promise<void> => discovered().catch((err: Error) => {
    sessions.notFound(err.message);
    say(`its agents were not reported this time, so Koala keeps the ones it last heard of: ${err.message}`);
  });
  const discovered = async (): Promise<void> => {
    const manual = await manualOver(socket);
    const found = await reportAgents(deps, manual, () => place.agentsNotSetUp(), (report, launches) => {
      sessions.setLaunches(launches);
      socket.emit('agents:found', report);
    });
    sessions.setLaunches(found.launches);
    const ready = found.agents.filter((agent) => agent.state === 'ready').map((agent) => agent.id);
    console.log(`[koala-local-agent] external agents: ${ready.length ? ready.join(', ') : 'none ready'}`);
  };
  socket.on('connect', () => { void rediscover(); });
  socket.on('agents:changed', () => { void rediscover(); });
  socket.on('agents:install', ({ id }: { id?: string }, ack: (answer: { ok: boolean; output: string }) => void) => {
    const known = KNOWN_AGENTS.find((agent) => agent.id === id);
    if (!known?.install) return ack({ ok: false, output: `there is nothing to install for ${String(id)}` });
    const install = known.install;
    void holding(gate, `installing ${known.id}'s adapter`, () => installAgent(install)).then((outcome) => {
      ack(outcome);
      void rediscover();
    });
  });
}


export function startWork(
  place: AgentPlace,
  config: MachineConfig,
  koala: Koala,
  access: KoalaAccess,
  sessionsMade: (sessions: ExternalAgentSessions) => void,
): { url: string; again: () => void } {
  const { rootDir } = config;
  const koalaUrl = koala.url;
  const gate = new IdleGate();
  const socket = koalaSocket({ url: koalaUrl, resource: koala.resource, access, auth: { bundle: place.ownBundle ?? '' }, say });
  const bundlePlace = placeOf(place.agentDir);
  let worker: DeviceWorkerHost | undefined;
  const updates = new SelfUpdate({
    own: place.ownBundle,
    service: place.service,
    gate,
    prepare: (bundle) => prepareBundle({ place: bundlePlace, bundle, url: `${koalaUrl}/api/machines/agent.tgz`, node: process.execPath }),
    discard: () => discardBundle(bundlePlace),
    quiesce: () => worker?.pause() ?? Promise.resolve(),
    resume: () => worker?.resume() ?? Promise.resolve(),
    swap: () => swapBundle(bundlePlace),
    restart: () => place.exit(0),
    report: (report: UpdateReport) => { if (socket.connected) socket.emit('machine:update', report); },
    log: say,
  });
  socket.on('machine:bundle', (named: unknown) => { void updates.named(named); });
  startTelemetry({ service: 'koala-machine', ...(config.deviceId ? { machineId: config.deviceId } : {}), sink: socketSink(socket), log: (line) => console.warn(`[koala-local-agent] ${line}`) });
  const mcp = new LocalMcpServer({ log: say });
  void mcp.start();
  const tellRuns = (runIds: string[]) => { if (socket.connected) socket.emit('machine:runs', { runIds }); };
  const sessions = new ExternalAgentSessions({ rootDir, mcp, gate, onRunsChanged: tellRuns });
  sessionsMade(sessions);
  socket.on('connect', () => tellRuns(sessions.openRuns()));
  socket.on('connect', () => {
    Promise.all([clusterOnConnect(place.cluster, say), machineGpus(place.cluster)]).then(
      ([state, gpus]) => { if (socket.connected) socket.emit('machine:cluster', { state, ...gpus, capacity: machineCapacity() }); },
      (err: Error) => say(`whether this machine has its cluster could not be read: ${err.message}`),
    );
  });
  socket.on('machine:run-ended', ({ runId }: { runId?: unknown } = {}) => {
    if (typeof runId !== 'string') return;
    void sessions.closeRun(runId).then((closed) => {
      if (closed) say(`${runId} ended, so its ${closed === 1 ? 'session is' : `${closed} sessions are`} closed`);
    });
  });
  place.onStop(() => { void sessions.closeAll().finally(() => place.exit(0)); });
  watchAgents(place, socket, config, sessions, gate);
  worker = followEngineWorker(socket, config, { url: koalaUrl, resource: koala.resource, access }, sessions, gate, place.cluster, place.startDeviceWorker);

  socket.on('connect', () => say(`connected to its Koala at ${koalaUrl} — root: ${rootDir}`));
  socket.on('disconnect', (reason) => say(`disconnected from its Koala: ${reason}`));
  socket.on('connect_error', (err: Error) => {
    console.error(`[koala-local-agent] its Koala refused or could not be reached: ${err.message}`);
  });

  socket.on('sandbox:exec', (
    { command, cwd, maxOutputChars, timeoutMs }: { leafId: string; command: string; cwd?: string; maxOutputChars?: number; timeoutMs?: number },
    ack: (result: ExecResult) => void,
  ) => {
    void holding(gate, 'a command', () => {
      const options: { timeoutMs?: number | undefined; subPath?: string | undefined; maxOutputChars?: number | undefined } = {
        ...(timeoutMs ? { timeoutMs } : {}),
      };
      if (cwd !== undefined) options.subPath = cwd;
      if (maxOutputChars !== undefined) options.maxOutputChars = maxOutputChars;
      return runCommand(rootDir, command, options);
    }).then(ack, (err: Error) => ack({ stdout: '', stderr: `the command could not start: ${err.message}`, exitCode: -1, timedOut: false }));
  });

  socket.on('sandbox:readFile', (
    { path: relativePath }: { leafId: string; path: string },
    ack: (result: { content: string } | { error: string }) => void,
  ) => {
    void readLocalFile(rootDir, relativePath).then(ack);
  });

  socket.on('sandbox:writeFile', (
    { path: relativePath, content, encoding }: { leafId: string; path: string; content: string; encoding?: 'base64' },
    ack: (result?: { error: string }) => void,
  ) => {
    const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
    void writeLocalFile(rootDir, relativePath, bytes).then(ack);
  });

  socket.on('sandbox:listDir', (
    { path: relativePath }: { path: string },
    ack: (result: { entries: { name: string; path: string; type: 'file' | 'dir' }[] } | { error: string }) => void,
  ) => {
    void listLocalDir(rootDir, relativePath).then(ack);
  });

  socket.on('sandbox:deleteFile', (
    { path: relativePath }: { path: string },
    ack: (result?: { error: string }) => void,
  ) => {
    void deleteLocalFile(rootDir, relativePath).then(ack);
  });

  return { url: koalaUrl, again: () => { if (connectAgainIfRefused(socket)) say(`asking its Koala at ${koalaUrl} again, now that root is back`); } };
}

