import type { Socket } from 'socket.io';
import { decryptValue, type SecretKey } from '../../platform/lib/crypto.js';
import { deviceTokenHash, hashesEqual, viaOf, withLifetime, type TokenVia } from './device-tokens.js';
import type { LocalAgentDeviceMetadata, LocalEgressRule } from '../../platform/index.js';

interface DeviceConnection {
  socket: Socket;
  ownerId: string;
  rootDir: string;
  connectedAt: number;
  containerMode: boolean;
}

const devices = new Map<string, DeviceConnection>();

export { deviceTokenHash } from './device-tokens.js';

export interface TokenMatch {
  device: LocalAgentDeviceMetadata;
  via: TokenVia;
  expired: boolean;
}

export function matchDeviceToken(
  candidates: readonly LocalAgentDeviceMetadata[],
  presentedToken: string,
  masterKey: SecretKey,
  now: Date = new Date(),
): TokenMatch | undefined {
  const presented = deviceTokenHash(presentedToken);
  for (const device of candidates) {
    const found = viaOf(device, presented, now);
    if (found) return { device, ...found };
    if (device.tokenHash || !device.tokenEnc) continue;
    try {
      if (hashesEqual(decryptValue(device.tokenEnc, masterKey), presentedToken)) return { device, via: 'current', expired: false };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function findDeviceByToken(
  candidates: readonly LocalAgentDeviceMetadata[],
  presentedToken: string,
  masterKey: SecretKey,
  now: Date = new Date(),
): LocalAgentDeviceMetadata | undefined {
  const match = matchDeviceToken(candidates, presentedToken, masterKey, now);
  return match && !match.expired ? match.device : undefined;
}

export async function hashDeviceTokens(
  store: { getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]>; saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void> },
  masterKey: SecretKey,
): Promise<number> {
  let hashed = 0;
  for (const device of await store.getLocalAgentDevices()) {
    if (device.tokenHash || !device.tokenEnc) continue;
    const { tokenEnc, ...rest } = device;
    await store.saveLocalAgentDevice({ ...rest, tokenHash: deviceTokenHash(decryptValue(tokenEnc, masterKey)) });
    hashed += 1;
  }
  return hashed;
}

export async function giveDeviceTokenLifetimes(
  store: { getLocalAgentDevices(): Promise<LocalAgentDeviceMetadata[]>; saveLocalAgentDevice(device: LocalAgentDeviceMetadata): Promise<void> },
  now: Date,
): Promise<number> {
  let given = 0;
  for (const device of await store.getLocalAgentDevices()) {
    const dated = withLifetime(device, now);
    if (dated === device) continue;
    await store.saveLocalAgentDevice(dated);
    given += 1;
  }
  return given;
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

export class DeviceGoneError extends Error {
  constructor(deviceId: string) {
    super(`Local device ${deviceId} disconnected before it answered`);
    this.name = 'DeviceGoneError';
  }
}

function ask<T>(deviceId: string, conn: DeviceConnection, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!conn.socket.connected) return reject(new DeviceGoneError(deviceId));
    const gone = () => reject(new DeviceGoneError(deviceId));
    conn.socket.once('disconnect', gone);
    conn.socket.emit(event, payload, (response: T) => {
      conn.socket.off('disconnect', gone);
      resolve(response);
    });
  });
}

function connectionFor(deviceId: string, ownerId: string): DeviceConnection {
  const conn = devices.get(deviceId);
  if (!conn) throw new Error(`Local device ${deviceId} is not connected`);
  if (conn.ownerId !== ownerId) throw new Error(`Local device ${deviceId} does not belong to this account`);
  return conn;
}

export function askDevice<T>(deviceId: string, ownerId: string, event: string, payload: unknown): Promise<T> {
  return ask<T>(deviceId, connectionFor(deviceId, ownerId), event, payload);
}

export function dropDevice(deviceId: string): void {
  const connection = devices.get(deviceId);
  if (!connection) return;
  connection.socket.emit('machine:removed');
  connection.socket.disconnect(true);
  devices.delete(deviceId);
}

export function tellDevice(deviceId: string, event: string): boolean {
  const conn = devices.get(deviceId);
  if (!conn?.socket.connected) return false;
  conn.socket.emit(event, {});
  return true;
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
  timeoutMs?: number,
  cwd?: string,
): Promise<LocalExecResult> {
  const conn = connectionFor(deviceId, ownerId);
  return ask<LocalExecResult>(deviceId, conn, 'sandbox:exec', { leafId, command, ...(cwd ? { cwd } : {}), ...(timeoutMs ? { timeoutMs } : {}) })
    .catch((err: Error) => ({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false }));
}

const answered = <T>(response: T | { error: string }): T => {
  if (response && typeof response === 'object' && 'error' in response) throw new Error((response as { error: string }).error);
  return response as T;
};

export async function readFileOnDevice(deviceId: string, ownerId: string, leafId: string, path: string): Promise<string> {
  const conn = connectionFor(deviceId, ownerId);
  return answered(await ask<{ content: string } | { error: string }>(deviceId, conn, 'sandbox:readFile', { leafId, path })).content;
}

export async function writeFileOnDevice(deviceId: string, ownerId: string, leafId: string, path: string, content: string | Buffer): Promise<void> {
  const conn = connectionFor(deviceId, ownerId);
  const sent = typeof content === 'string' ? { content } : { content: content.toString('base64'), encoding: 'base64' as const };
  answered(await ask<Record<string, never> | { error: string } | undefined>(deviceId, conn, 'sandbox:writeFile', { leafId, path, ...sent }) ?? {});
}

export interface LocalDirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

export async function listDirOnDevice(deviceId: string, ownerId: string, dirPath: string): Promise<LocalDirEntry[]> {
  const conn = connectionFor(deviceId, ownerId);
  return answered(await ask<{ entries: LocalDirEntry[] } | { error: string }>(deviceId, conn, 'sandbox:listDir', { path: dirPath })).entries;
}

export async function deleteFileOnDevice(deviceId: string, ownerId: string, filePath: string): Promise<void> {
  const conn = connectionFor(deviceId, ownerId);
  answered(await ask<Record<string, never> | { error: string } | undefined>(deviceId, conn, 'sandbox:deleteFile', { path: filePath }) ?? {});
}

export interface CreateContainerRequest {
  leafId: string;
  image: string;
  cpu?: string;
  memory?: string;
  egress?: LocalEgressRule[];
}

export async function createContainerOnDevice(
  deviceId: string,
  ownerId: string,
  request: CreateContainerRequest,
): Promise<{ containerMode: boolean; error?: string }> {
  const conn = connectionFor(deviceId, ownerId);
  return ask<{ containerMode: boolean; error?: string } | undefined>(deviceId, conn, 'sandbox:createContainer', request)
    .then((response) => response ?? { containerMode: false })
    .catch((err: Error) => ({ containerMode: false, error: err.message }));
}

export async function destroyContainerOnDevice(deviceId: string, ownerId: string, leafId: string): Promise<void> {
  const conn = connectionFor(deviceId, ownerId);
  await ask<unknown>(deviceId, conn, 'sandbox:destroyContainer', { leafId }).catch(() => undefined);
}
