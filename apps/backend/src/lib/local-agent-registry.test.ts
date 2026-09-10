import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { encryptValue } from './crypto.js';
import type { LocalAgentDeviceMetadata } from './types.js';
import {
  findDeviceByToken, registerDevice, unregisterDevice, localAgentStatus,
  execOnDevice, readFileOnDevice, writeFileOnDevice, createContainerOnDevice, destroyContainerOnDevice,
} from './local-agent-registry.js';

const MASTER_KEY = 'test-master-key';

function device(over: Partial<LocalAgentDeviceMetadata> = {}): LocalAgentDeviceMetadata {
  return {
    id: 'dev-1', ownerId: 'owner-1', name: 'Test box', rootDir: '/home/me',
    tokenEnc: encryptValue('the-real-token', MASTER_KEY), createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function fakeSocket(handler: (event: string, payload: unknown, ack: (...args: any[]) => void) => void): Socket {
  return {
    timeout: () => ({
      emit: (event: string, payload: unknown, ack: (...args: any[]) => void) => handler(event, payload, ack),
    }),
  } as unknown as Socket;
}

describe('findDeviceByToken', () => {
  it('finds the device whose decrypted token matches', () => {
    const d = device();
    const found = findDeviceByToken([d, device({ id: 'dev-2', tokenEnc: encryptValue('other', MASTER_KEY) })], 'the-real-token', MASTER_KEY);
    expect(found?.id).toBe('dev-1');
  });

  it('finds nothing for a token that matches no device', () => {
    expect(findDeviceByToken([device()], 'wrong-token', MASTER_KEY)).toBeUndefined();
  });

  it('does not throw when a stored token fails to decrypt', () => {
    const broken = device({ tokenEnc: 'not-even-encrypted' });
    expect(findDeviceByToken([broken], 'anything', MASTER_KEY)).toBeUndefined();
  });
});

describe('device registry status', () => {
  it('is offline until registered, online while connected, offline again after unregister', () => {
    const socket = fakeSocket(() => undefined);
    expect(localAgentStatus('dev-status').online).toBe(false);

    registerDevice('dev-status', 'owner-1', '/root', socket);
    expect(localAgentStatus('dev-status').online).toBe(true);

    unregisterDevice('dev-status', socket);
    expect(localAgentStatus('dev-status').online).toBe(false);
  });

  it('does not unregister when a different (stale) socket asks', () => {
    const first = fakeSocket(() => undefined);
    const second = fakeSocket(() => undefined);
    registerDevice('dev-stale', 'owner-1', '/root', first);
    registerDevice('dev-stale', 'owner-1', '/root', second);

    unregisterDevice('dev-stale', first);
    expect(localAgentStatus('dev-stale').online).toBe(true);
  });
});

describe('execOnDevice', () => {
  it('rejects when the device is not connected', async () => {
    await expect(execOnDevice('dev-missing', 'owner-1', 'leaf-1', 'ls')).rejects.toThrow(/not connected/);
  });

  it('rejects when the connected device belongs to a different owner', async () => {
    registerDevice('dev-owned', 'owner-a', '/root', fakeSocket(() => undefined));
    await expect(execOnDevice('dev-owned', 'owner-b', 'leaf-1', 'ls')).rejects.toThrow(/does not belong/);
  });

  it('resolves with the acked result', async () => {
    const socket = fakeSocket((event, payload, ack) => {
      expect(event).toBe('sandbox:exec');
      expect(payload).toEqual({ leafId: 'leaf-1', command: 'echo hi' });
      ack(null, { stdout: 'hi', stderr: '', exitCode: 0, timedOut: false });
    });
    registerDevice('dev-exec', 'owner-1', '/root', socket);

    const result = await execOnDevice('dev-exec', 'owner-1', 'leaf-1', 'echo hi');
    expect(result).toEqual({ stdout: 'hi', stderr: '', exitCode: 0, timedOut: false });
  });

  it('resolves with a timedOut result instead of throwing when the ack times out', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack(new Error('operation has timed out'));
    });
    registerDevice('dev-timeout', 'owner-1', '/root', socket);

    const result = await execOnDevice('dev-timeout', 'owner-1', 'leaf-1', 'sleep 999');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });
});

describe('readFileOnDevice / writeFileOnDevice', () => {
  it('reads a file back from the device', async () => {
    const socket = fakeSocket((event, _payload, ack) => {
      expect(event).toBe('sandbox:readFile');
      ack(null, { content: 'file contents' });
    });
    registerDevice('dev-read', 'owner-1', '/root', socket);

    expect(await readFileOnDevice('dev-read', 'owner-1', 'leaf-1', 'a.txt')).toBe('file contents');
  });

  it('rejects when the device reports an error reading', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack(null, { error: 'ENOENT' });
    });
    registerDevice('dev-read-err', 'owner-1', '/root', socket);

    await expect(readFileOnDevice('dev-read-err', 'owner-1', 'leaf-1', 'missing.txt')).rejects.toThrow('ENOENT');
  });

  it('writes a file and resolves on success', async () => {
    const socket = fakeSocket((event, payload, ack) => {
      expect(event).toBe('sandbox:writeFile');
      expect(payload).toEqual({ leafId: 'leaf-1', path: 'a.txt', content: 'hello' });
      ack(null);
    });
    registerDevice('dev-write', 'owner-1', '/root', socket);

    await expect(writeFileOnDevice('dev-write', 'owner-1', 'leaf-1', 'a.txt', 'hello')).resolves.toBeUndefined();
  });

  it('rejects when the device reports an error writing', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack(null, { error: 'disk full' });
    });
    registerDevice('dev-write-err', 'owner-1', '/root', socket);

    await expect(writeFileOnDevice('dev-write-err', 'owner-1', 'leaf-1', 'a.txt', 'x')).rejects.toThrow('disk full');
  });
});

describe('createContainerOnDevice / destroyContainerOnDevice', () => {
  it('sends the request and returns the acked containerMode', async () => {
    const socket = fakeSocket((event, payload, ack) => {
      expect(event).toBe('sandbox:createContainer');
      expect(payload).toEqual({ leafId: 'leaf-1', image: 'ubi9/nodejs-22' });
      ack(null, { containerMode: true });
    });
    registerDevice('dev-create', 'owner-1', '/root', socket);

    const result = await createContainerOnDevice('dev-create', 'owner-1', { leafId: 'leaf-1', image: 'ubi9/nodejs-22' });
    expect(result).toEqual({ containerMode: true });
  });

  it('resolves containerMode: false instead of throwing when the ack times out', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack(new Error('operation has timed out'));
    });
    registerDevice('dev-create-timeout', 'owner-1', '/root', socket);

    const result = await createContainerOnDevice('dev-create-timeout', 'owner-1', { leafId: 'leaf-1', image: 'x' });
    expect(result.containerMode).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('passes through a reported error alongside containerMode: false', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack(null, { containerMode: false, error: 'Docker is not running' });
    });
    registerDevice('dev-create-err', 'owner-1', '/root', socket);

    const result = await createContainerOnDevice('dev-create-err', 'owner-1', { leafId: 'leaf-1', image: 'x' });
    expect(result).toEqual({ containerMode: false, error: 'Docker is not running' });
  });

  it('destroy sends the leafId and resolves once acked', async () => {
    let sent: unknown;
    const socket = fakeSocket((event, payload, ack) => {
      sent = { event, payload };
      ack();
    });
    registerDevice('dev-destroy', 'owner-1', '/root', socket);

    await destroyContainerOnDevice('dev-destroy', 'owner-1', 'leaf-1');
    expect(sent).toEqual({ event: 'sandbox:destroyContainer', payload: { leafId: 'leaf-1' } });
  });
});
