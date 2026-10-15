import { execFile } from 'child_process';
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
import { ExternalAgentSessions, koalaTools } from './external-agents.js';
import { LocalMcpServer } from './local-mcp.js';

const activeContainers = new Set<string>();

const searchMemoriesOver = (socket: Socket) => (query: string) => new Promise<string>((resolve, reject) => {
  if (!socket.connected) return reject(new Error('this machine is not connected to Koala right now'));
  const gone = () => reject(new Error('this machine lost its connection to Koala before the search answered'));
  socket.once('disconnect', gone);
  socket.emit('memories:search', { query }, (answer: { text: string }) => {
    socket.off('disconnect', gone);
    resolve(answer.text);
  });
});

const manualOver = (socket: Socket) => new Promise<ManualAgent[]>((resolve) => {
  socket.emit('agents:manual', {}, (answer: unknown) => resolve(manualAgentsFrom(answer)));
});

function watchAgents(socket: Socket, config: MachineConfig, sessions: ExternalAgentSessions): void {
  const deps = systemDeps(config.rootDir, probeAcp);
  const rediscover = async (): Promise<void> => {
    const manual = await manualOver(socket);
    const found = await discoverAgents(deps, manual, (agents: FoundAgent[]) => socket.emit('agents:found', { agents }));
    sessions.setLaunches(found.launches);
    const ready = found.agents.filter((agent) => agent.state === 'ready').map((agent) => agent.id);
    console.log(`[koala-local-agent] external agents: ${ready.length ? ready.join(', ') : 'none ready'}`);
  };
  socket.on('connect', () => { void rediscover(); });
  socket.on('agents:changed', () => { void rediscover(); });
  socket.on('agents:install', ({ id }: { id?: string }, ack: (answer: { ok: boolean; output: string }) => void) => {
    const known = KNOWN_AGENTS.find((agent) => agent.id === id);
    if (!known?.adapter) return ack({ ok: false, output: `there is nothing to install for ${String(id)}` });
    execFile('npm', ['install', '--global', known.adapter], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim().split('\n').slice(-20).join('\n');
      ack({ ok: !err, output: err ? `${err.message}\n${output}` : output });
      void rediscover();
    });
  });
}

async function startEngineWorkerIfConfigured(config: MachineConfig, sessions: ExternalAgentSessions): Promise<void> {
  if (!config.deviceId || !config.temporalAddress) {
    if (config.deviceId || config.temporalAddress) {
      console.warn('[koala-local-agent] engine worker not started — it needs both a device id and a Temporal address.');
    }
    return;
  }
  try {
    const { startDeviceWorker } = await import('./engine-worker.js');
    const worker = await startDeviceWorker({
      rootDir: config.rootDir,
      deviceId: config.deviceId,
      externalAgents: sessions,
      address: config.temporalAddress,
      ...(config.temporalNamespace ? { namespace: config.temporalNamespace } : {}),
      onReady: (queue) => console.log(`[koala-local-agent] engine worker polling ${queue} at ${config.temporalAddress}`),
    });
    void worker.run().catch((err: unknown) => {
      console.error(`[koala-local-agent] engine worker stopped: ${(err as Error).message}`);
    });
  } catch (err) {
    console.error(`[koala-local-agent] could not start the engine worker: ${(err as Error).message}`);
  }
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
  const mcp = new LocalMcpServer();
  await mcp.start();
  const sessions = new ExternalAgentSessions({ rootDir, launches: {}, mcp, tools: koalaTools(searchMemoriesOver(socket)) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void sessions.closeAll().finally(() => process.exit(0)); });
  }
  watchAgents(socket, config, sessions);
  await startEngineWorkerIfConfigured(config, sessions);

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
    { leafId, path: relativePath, content }: { leafId: string; path: string; content: string },
    ack: (result?: { error: string }) => void,
  ) => {
    if (activeContainers.has(leafId)) {
      writeFileInContainer(leafId, relativePath, content).then(
        () => ack(),
        (err: Error) => ack({ error: err.message }),
      );
    } else {
      writeLocalFile(rootDir, relativePath, content).then(ack);
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

main().catch((err) => {
  console.error(`[koala-local-agent] fatal: ${err.message}`);
  process.exit(1);
});
