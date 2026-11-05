import { createMachineGit } from './machine-git.js';
import { mkdir } from 'fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { io, type Socket } from 'socket.io-client';
import {
  runCommand, readLocalFile, writeLocalFile, listLocalDir, deleteLocalFile, type ExecResult,
} from './sandbox-handlers.js';
import {
  dockerAvailable, createContainer, destroyContainer, execInContainer, readFileInContainer,
  writeFileInContainer, type EgressRule,
} from './docker-driver.js';
import { configFile, loadMachineConfig, type MachineConfig } from './machine-config.js';
import { linkToRoot } from './root-link.js';
import { KNOWN_AGENTS, discoverAgents, manualAgentsFrom, systemDeps, type FoundAgent, type ManualAgent } from './agent-discovery.js';
import { probeAcp } from './acp-session.js';
import { installAgent } from './agent-install.js';
import { ADAPTER_CHOICES, setUpAgents, type AdapterChoice } from './agent-setup.js';
import { askOnTerminal } from './terminal-ask.js';
import { ExternalAgentSessions } from './external-agents.js';
import { LocalMcpServer } from './local-mcp.js';
import { engineSettingsOver, remoteBlobs } from './remote-blobs.js';
import { DeviceWorkerHost } from './device-worker-host.js';
import { forgetThisMachine, meshIp } from './machine-removal.js';
import { clusterOnConnect, hostCluster, runMachineCluster, startIfWanted, uninstallMachineCluster } from './machine-cluster.js';
import { installKoala, placedFrom } from './koala-install.js';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { socketSink } from './telemetry-sink.js';
import { IdleGate, holding, type Release } from './idle-gate.js';
import { SelfUpdate, serviceManagerOf, type UpdateReport } from './self-update.js';
import { discardBundle, ownBundle, ownVersion, placeOf, prepareBundle, readCgroup, swapBundle } from './agent-bundle.js';

const activeContainers = new Map<string, Release>();
const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWN_BUNDLE = ownBundle(AGENT_DIR);

const manualOver = (socket: Socket) => new Promise<ManualAgent[]>((resolve) => {
  socket.emit('agents:manual', {}, (answer: unknown) => resolve(manualAgentsFrom(answer)));
});

function watchAgents(socket: Socket, config: MachineConfig, sessions: ExternalAgentSessions, gate: IdleGate): void {
  const deps = systemDeps(config.rootDir, probeAcp);
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

interface WorkToken {
  value: string;
}

function followEngineWorker(socket: Socket, config: MachineConfig, koalaUrl: string, work: WorkToken, sessions: ExternalAgentSessions, gate: IdleGate): DeviceWorkerHost | undefined {
  if (!config.deviceId) return undefined;
  const { deviceId } = config;
  const host = new DeviceWorkerHost(async (settings) => {
    const address = settings.temporal?.address;
    const namespace = settings.temporal?.namespace;
    if (!address) throw new Error('Koala named no Temporal for this machine to take work from');
    const { startDeviceWorker } = await import('./engine-worker.js');
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

const machineCluster = hostCluster(meshIp);

const say = (line: string) => console.log(`[koala-local-agent] ${line}`);

const helmBinary = (env: NodeJS.ProcessEnv = process.env) => path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'koala', 'bin', 'helm');

let placing = false;
const placeKoala = (raw: unknown): boolean => {
  const placed = placedFrom(raw);
  if (!placed || placing) return false;
  placing = true;
  say(`root asks for Koala on this machine (${placed.instanceId})`);
  void installKoala(placed, { cluster: machineCluster, helm: helmBinary(), fetch, say }).finally(() => { placing = false; });
  return true;
};

const forgetAndStop = (closing: () => Promise<unknown>) => {
  void closing()
    .finally(() => uninstallMachineCluster(machineCluster, say))
    .finally(() => forgetThisMachine(say))
    .finally(() => process.exit(0));
};

async function main() {
  const config = await loadMachineConfig();
  const { rootUrl, rootDir } = config;
  await mkdir(rootDir, { recursive: true });
  const service = serviceManagerOf(process.platform, process.env, await readCgroup());
  void startIfWanted(machineCluster, say).catch((err: Error) => say(`this machine's cluster could not start again: ${err.message}`));
  let sessionsOf: ExternalAgentSessions | undefined;
  let working: { url: string; setToken(token: string): Promise<void> } | undefined;
  const root = linkToRoot({
    rootUrl,
    token: config.token,
    configFile: configFile(),
    meshIp,
    say,
    onRemoved: () => forgetAndStop(() => sessionsOf?.closeAll() ?? Promise.resolve()),
    onPlaceKoala: placeKoala,
    onKoala: (koala) => {
      if (!working) {
        working = startWork(config, koala.url, koala.workToken, service, () => root.askKoala(), (sessions) => { sessionsOf = sessions; });
        return;
      }
      if (working.url !== koala.url) {
        say(`this machine's Koala is now at ${koala.url}`);
        if (service) process.exit(0);
        say('start the agent again to work for it there');
        return;
      }
      void working.setToken(koala.workToken);
    },
  });
}

function startWork(
  config: MachineConfig,
  koalaUrl: string,
  firstToken: string,
  service: ReturnType<typeof serviceManagerOf>,
  askKoala: () => void,
  sessionsMade: (sessions: ExternalAgentSessions) => void,
): { url: string; setToken(token: string): Promise<void> } {
  const { rootDir } = config;
  const work: WorkToken = { value: firstToken };
  const gate = new IdleGate();
  const socket = io(`${koalaUrl}/agent`, { auth: { token: work.value, containerMode: false, bundle: OWN_BUNDLE ?? '' }, reconnection: true });
  let containerMode = false;
  void dockerAvailable().then((docker) => {
    containerMode = docker.ok;
    socket.auth = { ...(socket.auth as Record<string, unknown>), containerMode };
    if (docker.ok) say('Docker detected — leaves will run in isolated containers.');
    else console.warn(`[koala-local-agent] ${docker.reason} Falling back to running leaves directly on this host.`);
  });
  const place = placeOf(AGENT_DIR);
  let worker: DeviceWorkerHost | undefined;
  const updates = new SelfUpdate({
    own: OWN_BUNDLE,
    service,
    gate,
    prepare: (bundle) => prepareBundle({ place, bundle, url: `${koalaUrl}/api/machines/agent.tgz`, node: process.execPath }),
    discard: () => discardBundle(place),
    quiesce: () => worker?.pause() ?? Promise.resolve(),
    resume: () => worker?.resume() ?? Promise.resolve(),
    swap: () => swapBundle(place),
    restart: () => process.exit(0),
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
    clusterOnConnect(machineCluster, say).then(
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
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void sessions.closeAll().finally(() => process.exit(0)); });
  }
  watchAgents(socket, config, sessions, gate);
  worker = followEngineWorker(socket, config, koalaUrl, work, sessions, gate);

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

async function setUpAgentsHere(args: string[]): Promise<void> {
  const flag = args.indexOf('--adapters');
  const choice = (flag >= 0 ? args[flag + 1] : 'ask') as AdapterChoice;
  if (!ADAPTER_CHOICES.includes(choice)) throw new Error(`--adapters takes ${ADAPTER_CHOICES.join(', ')}`);
  const config = await loadMachineConfig();
  await mkdir(config.rootDir, { recursive: true });
  await setUpAgents(choice, { discovery: systemDeps(config.rootDir, probeAcp), install: (install) => installAgent(install) }, {
    ok: (line) => console.log(`  \x1b[32m✓\x1b[0m ${line}`),
    note: (line) => console.log(`  • ${line}`),
    fail: (line) => console.log(`  \x1b[31m✗\x1b[0m ${line}`),
    ask: askOnTerminal,
  });
}

function sayVersion(): Promise<void> {
  console.log(JSON.stringify({ bundle: OWN_BUNDLE ?? null, version: ownVersion(AGENT_DIR) ?? null }));
  return Promise.resolve();
}

const command = process.argv[2];
const started = command === 'agents' ? setUpAgentsHere(process.argv.slice(3)) : command === 'version' ? sayVersion() : main();
started.then(() => {
  if (command === 'agents' || command === 'version') process.exit(0);
}, (err: Error) => {
  console.error(`[koala-local-agent] fatal: ${err.message}`);
  process.exit(1);
});
