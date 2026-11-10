import { io, type Socket } from 'socket.io-client';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import {
  runCommand, readLocalFile, writeLocalFile, listLocalDir, deleteLocalFile, type ExecResult,
} from './sandbox-handlers.js';
import {
  createContainer, destroyContainer, execInContainer, readFileInContainer, writeFileInContainer, type EgressRule,
} from './docker-driver.js';
import type { MachineConfig } from './machine-config.js';
import { KNOWN_AGENTS, discoverAgents, manualAgentsFrom, type DiscoveryDeps, type FoundAgent, type ManualAgent } from './agent-discovery.js';
import { installAgent } from './agent-install.js';
import { ExternalAgentSessions } from './external-agents.js';
import { LocalMcpServer } from './local-mcp.js';
import type { DeviceWorkerHost } from './device-worker-host.js';
import { followEngineWorker, type WorkToken } from './device-worker-follow.js';
import { clusterOnConnect, type ClusterHost } from './machine-cluster.js';
import { socketSink } from './telemetry-sink.js';
import { IdleGate, holding, type Release } from './idle-gate.js';
import { SelfUpdate, type serviceManagerOf, type UpdateReport } from './self-update.js';
import { discardBundle, placeOf, prepareBundle, swapBundle } from './agent-bundle.js';
import type { DeviceWorker, DeviceWorkerOptions } from './engine-worker.js';
import type { dockerAvailable } from './docker-cli.js';

export interface AgentPlace {
  agentDir: string;
  ownBundle: string | undefined;
  service: ReturnType<typeof serviceManagerOf>;
  dockerAvailable: typeof dockerAvailable;
  cluster: ClusterHost;
  discovery(rootDir: string): DiscoveryDeps;
  startDeviceWorker(options: DeviceWorkerOptions): Promise<DeviceWorker>;
  onStop(stop: () => void): void;
  exit(code: number): void;
}

const say = (line: string) => console.log(`[koala-local-agent] ${line}`);

const activeContainers = new Map<string, Release>();

const manualOver = (socket: Socket) => new Promise<ManualAgent[]>((resolve) => {
  socket.emit('agents:manual', {}, (answer: unknown) => resolve(manualAgentsFrom(answer)));
});

function watchAgents(place: AgentPlace, socket: Socket, config: MachineConfig, sessions: ExternalAgentSessions, gate: IdleGate): void {
  const deps = place.discovery(config.rootDir);
  const rediscover = async (): Promise<void> => {
    const manual = await manualOver(socket);
    const found = await discoverAgents(deps, manual, (agents: FoundAgent[], launches) => {
      sessions.setLaunches(launches);
      socket.emit('agents:found', { agents });
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
  koalaUrl: string,
  firstToken: string,
  askKoala: () => void,
  sessionsMade: (sessions: ExternalAgentSessions) => void,
): { url: string; setToken(token: string): Promise<void> } {
  const { rootDir } = config;
  const work: WorkToken = { value: firstToken };
  const gate = new IdleGate();
  const socket = io(`${koalaUrl}/agent`, { auth: { token: work.value, containerMode: false, bundle: place.ownBundle ?? '' }, reconnection: true });
  let containerMode = false;
  void place.dockerAvailable().then((docker) => {
    containerMode = docker.ok;
    socket.auth = { ...(socket.auth as Record<string, unknown>), containerMode };
    if (docker.ok) say('Docker detected — leaves will run in isolated containers.');
    else console.warn(`[koala-local-agent] ${docker.reason} Falling back to running leaves directly on this host.`);
  });
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
  const sessions = new ExternalAgentSessions({ rootDir, launches: {}, mcp, gate, onRunsChanged: tellRuns });
  sessionsMade(sessions);
  socket.on('connect', () => tellRuns(sessions.openRuns()));
  socket.on('connect', () => {
    clusterOnConnect(place.cluster, say).then(
      (state) => { if (socket.connected) socket.emit('machine:cluster', { state }); },
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
  worker = followEngineWorker(socket, config, koalaUrl, work, sessions, gate, place.cluster, place.startDeviceWorker);

  socket.on('connect', () => say(`connected to its Koala at ${koalaUrl} — root: ${rootDir}, containers: ${containerMode ? 'on' : 'off'}`));
  socket.on('disconnect', (reason) => say(`disconnected from its Koala: ${reason}`));
  socket.on('connect_error', (err: Error) => {
    console.error(`[koala-local-agent] its Koala refused or could not be reached: ${err.message}`);
    if (/work token/.test(err.message)) askKoala();
  });

  socket.on('sandbox:createContainer', (
    request: { leafId: string; image: string; cpu?: string; memory?: string; egress?: EgressRule[] },
    ack: (result: { containerMode: boolean; error?: string }) => void,
  ) => {
    if (!containerMode) return ack({ containerMode: false });
    const creating = gate.hold(`a container for ${request.leafId}`);
    createContainer({ ...request, rootDir })
      .then(() => {
        activeContainers.get(request.leafId)?.();
        activeContainers.set(request.leafId, creating);
        ack({ containerMode: true });
      })
      .catch((err: Error) => {
        creating();
        console.warn(`[koala-local-agent] ${request.leafId}: container create failed (${err.message}) — falling back to raw host exec for this leaf`);
        ack({ containerMode: false, error: err.message });
      });
  });

  socket.on('sandbox:destroyContainer', (
    { leafId }: { leafId: string },
    ack: () => void,
  ) => {
    const release = activeContainers.get(leafId);
    if (!release) return ack();
    activeContainers.delete(leafId);
    destroyContainer(leafId).catch((err: Error) => {
      console.warn(`[koala-local-agent] ${leafId}: container cleanup failed: ${err.message}`);
    }).finally(() => {
      release();
      ack();
    });
  });

  socket.on('sandbox:exec', (
    { leafId, command, cwd, maxOutputChars, timeoutMs }: { leafId: string; command: string; cwd?: string; maxOutputChars?: number; timeoutMs?: number },
    ack: (result: ExecResult) => void,
  ) => {
    void holding(gate, 'a command', () => {
      if (activeContainers.has(leafId)) return execInContainer(leafId, command, timeoutMs, cwd, maxOutputChars);
      const options: { timeoutMs?: number | undefined; subPath?: string | undefined; maxOutputChars?: number | undefined } = {
        ...(timeoutMs ? { timeoutMs } : {}),
      };
      if (cwd !== undefined) options.subPath = cwd;
      if (maxOutputChars !== undefined) options.maxOutputChars = maxOutputChars;
      return runCommand(rootDir, command, options);
    }).then(ack, (err: Error) => ack({ stdout: '', stderr: `the command could not start: ${err.message}`, exitCode: -1, timedOut: false }));
  });

  socket.on('sandbox:readFile', (
    { leafId, path: relativePath }: { leafId: string; path: string },
    ack: (result: { content: string } | { error: string }) => void,
  ) => {
    if (activeContainers.has(leafId)) {
      readFileInContainer(leafId, relativePath).then(
        (content) => ack({ content }),
        (err: Error) => ack({ error: err.message }),
      );
    } else {
      void readLocalFile(rootDir, relativePath).then(ack);
    }
  });

  socket.on('sandbox:writeFile', (
    { leafId, path: relativePath, content, encoding }: { leafId: string; path: string; content: string; encoding?: 'base64' },
    ack: (result?: { error: string }) => void,
  ) => {
    const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
    if (activeContainers.has(leafId)) {
      writeFileInContainer(leafId, relativePath, bytes).then(
        () => ack(),
        (err: Error) => ack({ error: err.message }),
      );
    } else {
      void writeLocalFile(rootDir, relativePath, bytes).then(ack);
    }
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

  return {
    url: koalaUrl,
    async setToken(token: string) {
      work.value = token;
      socket.auth = { ...(socket.auth as Record<string, unknown>), token };
      await worker?.setToken(token);
      say('this machine took a new work token from root');
    },
  };
}

