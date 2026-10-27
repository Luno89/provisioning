import { createMachineGit } from './machine-git.js';
import { mkdir } from 'fs/promises';
import { io, type Socket } from 'socket.io-client';
import {
  runCommand, readLocalFile, writeLocalFile, listLocalDir, deleteLocalFile, type ExecResult,
} from './sandbox-handlers.js';
import {
  dockerAvailable, createContainer, destroyContainer, execInContainer, readFileInContainer,
  writeFileInContainer, type EgressRule,
} from './docker-driver.js';
import { loadMachineConfig, type MachineConfig } from './machine-config.js';
import { KNOWN_AGENTS, discoverAgents, manualAgentsFrom, systemDeps, type FoundAgent, type ManualAgent } from './agent-discovery.js';
import { probeAcp } from './acp-session.js';
import { installAgent } from './agent-install.js';
import { ADAPTER_CHOICES, setUpAgents, type AdapterChoice } from './agent-setup.js';
import { askOnTerminal } from './terminal-ask.js';
import { ExternalAgentSessions } from './external-agents.js';
import { LocalMcpServer } from './local-mcp.js';
import { engineSettingsOver, remoteBlobs } from './remote-blobs.js';
import { DeviceWorkerHost } from './device-worker-host.js';
import { startTelemetry } from '@koala/engine-core/telemetry-sdk';
import { socketSink } from './telemetry-sink.js';

const activeContainers = new Set<string>();

const manualOver = (socket: Socket) => new Promise<ManualAgent[]>((resolve) => {
  socket.emit('agents:manual', {}, (answer: unknown) => resolve(manualAgentsFrom(answer)));
});

function watchAgents(socket: Socket, config: MachineConfig, sessions: ExternalAgentSessions): void {
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
    void installAgent(known.install).then((outcome) => {
      ack(outcome);
      void rediscover();
    });
  });
}

function followEngineWorker(socket: Socket, config: MachineConfig, sessions: ExternalAgentSessions): DeviceWorkerHost | undefined {
  if (!config.deviceId) return undefined;
  const { deviceId } = config;
  const host = new DeviceWorkerHost(async (settings) => {
    const address = settings.temporal?.address ?? config.temporalAddress;
    const namespace = settings.temporal?.namespace ?? config.temporalNamespace;
    if (!address) throw new Error('Koala named no Temporal for this machine to take work from');
    const { startDeviceWorker } = await import('./engine-worker.js');
    return startDeviceWorker({
      rootDir: config.rootDir,
      deviceId,
      externalAgents: sessions,
      git: createMachineGit({ rootDir: config.rootDir, backendUrl: config.backendUrl, token: config.token }),
      address,
      token: config.token,
      payloads: { ring: settings.ring, blobs: remoteBlobs(socket) },
      ...(namespace ? { namespace } : {}),
      onReady: (queue) => console.log(`[koala-local-agent] engine worker polling ${queue} at ${address}`),
    });
  });
  socket.on('connect', () => { void host.connected(() => engineSettingsOver(socket)); });
  return host;
}

async function main() {
  const config = await loadMachineConfig();
  const { backendUrl, token, rootDir } = config;
  await mkdir(rootDir, { recursive: true });
  const docker = await dockerAvailable();
  if (docker.ok) {
    console.log('[koala-local-agent] Docker detected — leaves will run in isolated containers.');
  } else {
    console.warn(`[koala-local-agent] ${docker.reason} Falling back to running leaves directly on this host.`);
  }
  const containerMode = docker.ok;

  const socket = io(`${backendUrl}/agent`, { auth: { token, containerMode }, reconnection: true });
  startTelemetry({ service: 'koala-machine', ...(config.deviceId ? { machineId: config.deviceId } : {}), sink: socketSink(socket), log: (line) => console.warn(`[koala-local-agent] ${line}`) });
  const mcp = new LocalMcpServer({ log: (line) => console.log(`[koala-local-agent] ${line}`) });
  await mcp.start();
  const sessions = new ExternalAgentSessions({ rootDir, launches: {}, mcp });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void sessions.closeAll().finally(() => process.exit(0)); });
  }
  watchAgents(socket, config, sessions);
  followEngineWorker(socket, config, sessions);

  socket.on('connect', () => {
    console.log(`[koala-local-agent] connected to ${backendUrl} — root: ${rootDir}, containers: ${containerMode ? 'on' : 'off'}`);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[koala-local-agent] disconnected: ${reason}`);
  });

  socket.on('connect_error', (err: Error) => {
    console.error(`[koala-local-agent] connect error: ${err.message}`);
  });

  socket.on('sandbox:createContainer', (
    request: { leafId: string; image: string; cpu?: string; memory?: string; egress?: EgressRule[] },
    ack: (result: { containerMode: boolean; error?: string }) => void,
  ) => {
    if (!containerMode) return ack({ containerMode: false });
    createContainer({ ...request, rootDir })
      .then(() => {
        activeContainers.add(request.leafId);
        ack({ containerMode: true });
      })
      .catch((err: Error) => {
        console.warn(`[koala-local-agent] ${request.leafId}: container create failed (${err.message}) — falling back to raw host exec for this leaf`);
        ack({ containerMode: false, error: err.message });
      });
  });

  socket.on('sandbox:destroyContainer', (
    { leafId }: { leafId: string },
    ack: () => void,
  ) => {
    if (!activeContainers.has(leafId)) return ack();
    activeContainers.delete(leafId);
    destroyContainer(leafId).catch((err: Error) => {
      console.warn(`[koala-local-agent] ${leafId}: container cleanup failed: ${err.message}`);
    }).finally(ack);
  });

  socket.on('sandbox:exec', (
    { leafId, command, cwd, maxOutputChars, timeoutMs }: { leafId: string; command: string; cwd?: string; maxOutputChars?: number; timeoutMs?: number },
    ack: (result: ExecResult) => void,
  ) => {
    if (activeContainers.has(leafId)) {
      execInContainer(leafId, command, timeoutMs, cwd, maxOutputChars).then(ack);
    } else {
      const options: { timeoutMs?: number | undefined; subPath?: string | undefined; maxOutputChars?: number | undefined } = {
        ...(timeoutMs ? { timeoutMs } : {}),
      };
      if (cwd !== undefined) options.subPath = cwd;
      if (maxOutputChars !== undefined) options.maxOutputChars = maxOutputChars;
      runCommand(rootDir, command, options).then(ack);
    }
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
      readLocalFile(rootDir, relativePath).then(ack);
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
      writeLocalFile(rootDir, relativePath, bytes).then(ack);
    }
  });

  socket.on('sandbox:listDir', (
    { path: relativePath }: { path: string },
    ack: (result: { entries: { name: string; path: string; type: 'file' | 'dir' }[] } | { error: string }) => void,
  ) => {
    listLocalDir(rootDir, relativePath).then(ack);
  });

  socket.on('sandbox:deleteFile', (
    { path: relativePath }: { path: string },
    ack: (result?: { error: string }) => void,
  ) => {
    deleteLocalFile(rootDir, relativePath).then(ack);
  });
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

const started = process.argv[2] === 'agents' ? setUpAgentsHere(process.argv.slice(3)) : main();
started.then(() => {
  if (process.argv[2] === 'agents') process.exit(0);
}, (err: Error) => {
  console.error(`[koala-local-agent] fatal: ${err.message}`);
  process.exit(1);
});
