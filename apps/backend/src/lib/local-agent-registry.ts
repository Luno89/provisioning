import crypto from 'crypto';
import type { Socket } from 'socket.io';
import { decryptValue } from './crypto.js';
import type { LocalAgentDeviceMetadata, LocalEgressRule } from './types.js';

interface DeviceConnection {
  socket: Socket;
  ownerId: string;
  rootDir: string;
  connectedAt: number;
  containerMode: boolean;
}

const devices = new Map<string, DeviceConnection>();

const DEFAULT_TIMEOUT_MS = 120_000;

function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function findDeviceByToken(
  candidates: readonly LocalAgentDeviceMetadata[],
  presentedToken: string,
  masterKey: string,
): LocalAgentDeviceMetadata | undefined {
  return candidates.find((d) => {
    try {
      return tokensEqual(decryptValue(d.tokenEnc, masterKey), presentedToken);
    } catch {
      return false;
    }
  });
}

export function registerDevice(
  deviceId: string,
  ownerId: string,
  rootDir: string,
  socket: Socket,
  containerMode = false,
): void {
  devices.set(deviceId, { socket, ownerId, rootDir, connectedAt: Date.now(), containerMode });
}

export function unregisterDevice(deviceId: string, socket: Socket): void {
  if (devices.get(deviceId)?.socket === socket) devices.delete(deviceId);
}

export function localAgentStatus(deviceId: string): { online: boolean; connectedAt?: string; containerMode?: boolean } {
  const conn = devices.get(deviceId);
  return conn
    ? { online: true, connectedAt: new Date(conn.connectedAt).toISOString(), containerMode: conn.containerMode }
    : { online: false };
}

function connectionFor(deviceId: string, ownerId: string): DeviceConnection {
  const conn = devices.get(deviceId);
  if (!conn) throw new Error(`Local device ${deviceId} is not connected`);
  if (conn.ownerId !== ownerId) throw new Error(`Local device ${deviceId} does not belong to this account`);
  return conn;
}

export interface LocalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export async function execOnDevice(
  deviceId: string,
  ownerId: string,
  leafId: string,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd?: string,
): Promise<LocalExecResult> {
  const conn = connectionFor(deviceId, ownerId);
  return new Promise((resolve) => {
    conn.socket.timeout(timeoutMs).emit(
      'sandbox:exec',
      { leafId, command, ...(cwd ? { cwd } : {}) },
      (err: unknown, response: LocalExecResult) => {
        if (err) {
          resolve({ stdout: '', stderr: 'Local device did not respond in time', exitCode: -1, timedOut: true });
          return;
        }
        resolve(response);
      },
    );
  });
}

export async function readFileOnDevice(
  deviceId: string,
  ownerId: string,
  leafId: string,
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const conn = connectionFor(deviceId, ownerId);
  return new Promise((resolve, reject) => {
    conn.socket.timeout(timeoutMs).emit(
      'sandbox:readFile',
      { leafId, path },
      (err: unknown, response: { content: string } | { error: string }) => {
        if (err) return reject(new Error(`Local device did not respond in time reading ${path}`));
        if (response && 'error' in response) return reject(new Error(response.error));
        resolve(response.content);
      },
    );
  });
}

export async function writeFileOnDevice(
  deviceId: string,
  ownerId: string,
  leafId: string,
  path: string,
  content: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const conn = connectionFor(deviceId, ownerId);
  return new Promise((resolve, reject) => {
    conn.socket.timeout(timeoutMs).emit(
      'sandbox:writeFile',
      { leafId, path, content },
      (err: unknown, response?: { error: string }) => {
        if (err) return reject(new Error(`Local device did not respond in time writing ${path}`));
        if (response && 'error' in response) return reject(new Error(response.error));
        resolve();
      },
    );
  });
}

export interface LocalDirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

export async function listDirOnDevice(
  deviceId: string,
  ownerId: string,
  dirPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LocalDirEntry[]> {
  const conn = connectionFor(deviceId, ownerId);
  return new Promise((resolve, reject) => {
    conn.socket.timeout(timeoutMs).emit(
      'sandbox:listDir',
      { path: dirPath },
      (err: unknown, response: { entries: LocalDirEntry[] } | { error: string }) => {
        if (err) return reject(new Error(`Local device did not respond in time listing ${dirPath || '.'}`));
        if (response && 'error' in response) return reject(new Error(response.error));
        resolve(response.entries);
      },
    );
  });
}

export async function deleteFileOnDevice(
  deviceId: string,
  ownerId: string,
  filePath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const conn = connectionFor(deviceId, ownerId);
  return new Promise((resolve, reject) => {
    conn.socket.timeout(timeoutMs).emit(
      'sandbox:deleteFile',
      { path: filePath },
      (err: unknown, response?: { error: string }) => {
        if (err) return reject(new Error(`Local device did not respond in time deleting ${filePath}`));
        if (response && 'error' in response) return reject(new Error(response.error));
        resolve();
      },
    );
  });
}

const CONTAINER_TIMEOUT_MS = 60_000;

export interface CreateContainerRequest {
  leafId: string;
  image: string;
  cpu?: string;
  memory?: string;
  egress?: LocalEgressRule[];
}

/**
 * Always resolves, never rejects — an agent still on the raw-exec fallback path (no Docker) acks
 * `{ containerMode: false }` and this is a no-op; `exec`/`readFile`/`writeFile` keep working against
 * the bare host either way, so the caller does not need to branch on the result.
 */
export async function createContainerOnDevice(
  deviceId: string,
  ownerId: string,
  request: CreateContainerRequest,
  timeoutMs = CONTAINER_TIMEOUT_MS,
): Promise<{ containerMode: boolean; error?: string }> {
  const conn = connectionFor(deviceId, ownerId);
  return new Promise((resolve) => {
    conn.socket.timeout(timeoutMs).emit(
      'sandbox:createContainer',
      request,
      (err: unknown, response?: { containerMode: boolean; error?: string }) => {
        if (err) return resolve({ containerMode: false, error: 'Local device did not respond in time creating a container' });
        resolve(response ?? { containerMode: false });
      },
    );
  });
}

export async function destroyContainerOnDevice(
  deviceId: string,
  ownerId: string,
  leafId: string,
  timeoutMs = CONTAINER_TIMEOUT_MS,
): Promise<void> {
  const conn = connectionFor(deviceId, ownerId);
  return new Promise((resolve) => {
    conn.socket.timeout(timeoutMs).emit('sandbox:destroyContainer', { leafId }, () => resolve());
  });
}
