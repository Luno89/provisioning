import path from 'path';
import { io } from 'socket.io-client';
import {
  runCommand, readLocalFile, writeLocalFile, listLocalDir, deleteLocalFile, DEFAULT_TIMEOUT_MS, type ExecResult,
} from './sandbox-handlers.js';
import {
  dockerAvailable, createContainer, destroyContainer, execInContainer, readFileInContainer,
  writeFileInContainer, type EgressRule,
} from './docker-driver.js';

const backendUrl = process.env.KOALA_BACKEND_URL;
const token = process.env.KOALA_DEVICE_TOKEN;
const rootDir = path.resolve(process.env.KOALA_ROOT_DIR ?? process.cwd());
const deviceId = process.env.KOALA_DEVICE_ID;
const temporalAddress = process.env.KOALA_TEMPORAL_ADDRESS;
const temporalNamespace = process.env.KOALA_TEMPORAL_NAMESPACE;

if (!backendUrl) throw new Error('KOALA_BACKEND_URL is required (e.g. http://localhost:3001)');
if (!token) throw new Error('KOALA_DEVICE_TOKEN is required — mint one from the My Machines page');

const activeContainers = new Set<string>();

async function startEngineWorkerIfConfigured(): Promise<void> {
  if (!deviceId || !temporalAddress) {
    if (deviceId || temporalAddress) {
      console.warn(
        '[koala-local-agent] engine worker not started — it needs both KOALA_DEVICE_ID and KOALA_TEMPORAL_ADDRESS.',
      );
    }
    return;
  }

  try {
    const { startDeviceWorker } = await import('./engine-worker.js');
    const worker = await startDeviceWorker({
      rootDir,
      deviceId,
      address: temporalAddress,
      ...(temporalNamespace ? { namespace: temporalNamespace } : {}),
      onReady: (queue) => console.log(`[koala-local-agent] engine worker polling ${queue} at ${temporalAddress}`),
    });

    void worker.run().catch((err: unknown) => {
      console.error(`[koala-local-agent] engine worker stopped: ${(err as Error).message}`);
    });
  } catch (err) {
    console.error(`[koala-local-agent] could not start the engine worker: ${(err as Error).message}`);
  }
}

async function main() {
  const docker = await dockerAvailable();
  if (docker.ok) {
    console.log('[koala-local-agent] Docker detected — leaves will run in isolated containers.');
  } else {
    console.warn(`[koala-local-agent] ${docker.reason} Falling back to running leaves directly on this host.`);
  }
  const containerMode = docker.ok;

  await startEngineWorkerIfConfigured();

  const socket = io(`${backendUrl}/agent`, { auth: { token, containerMode }, reconnection: true });

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
    { leafId, command, cwd, maxOutputChars }: { leafId: string; command: string; cwd?: string; maxOutputChars?: number },
    ack: (result: ExecResult) => void,
  ) => {
    if (activeContainers.has(leafId)) {
      execInContainer(leafId, command, DEFAULT_TIMEOUT_MS, cwd, maxOutputChars).then(ack);
    } else {
      const options: { timeoutMs: number; subPath?: string | undefined; maxOutputChars?: number | undefined } = {
        timeoutMs: DEFAULT_TIMEOUT_MS,
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
