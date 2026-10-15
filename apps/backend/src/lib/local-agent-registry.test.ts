import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { encryptValue } from './crypto.js';
import type { LocalAgentDeviceMetadata } from './types.js';
import {
  findDeviceByToken, registerDevice, unregisterDevice, localAgentStatus,
  execOnDevice, readFileOnDevice, writeFileOnDevice, createContainerOnDevice, destroyContainerOnDevice,
  listDirOnDevice, deleteFileOnDevice,
} from './local-agent-registry.js';

const MASTER_KEY = 'test-master-key';

function device(over: Partial<LocalAgentDeviceMetadata> = {}): LocalAgentDeviceMetadata {
  return {
    id: 'dev-1', ownerId: 'owner-1', name: 'Test box', rootDir: '/home/me',
    tokenEnc: encryptValue('the-real-token', MASTER_KEY), createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function fakeSocket(handler: (event: string, payload: unknown, ack: (...args: any[]) => void, disconnect: () => void) => void): Socket {
  const gone = new Set<() => void>();
  const socket = {
    connected: true,
    once: (event: string, listener: () => void) => { if (event === 'disconnect') gone.add(listener); },
    off: (event: string, listener: () => void) => { if (event === 'disconnect') gone.delete(listener); },
    emit: (event: string, payload: unknown, ack: (...args: any[]) => void) => handler(event, payload, ack, () => {
      socket.connected = false;
      for (const listener of gone) listener();
    }),
  };
  return socket as unknown as Socket;
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
      ack({ stdout: 'hi', stderr: '', exitCode: 0, timedOut: false });
    });
    registerDevice('dev-exec', 'owner-1', '/root', socket);

    const result = await execOnDevice('dev-exec', 'owner-1', 'leaf-1', 'echo hi');
    expect(result).toEqual({ stdout: 'hi', stderr: '', exitCode: 0, timedOut: false });
  });

  it('waits for a command however long it runs, and hands the device only the limit the caller set', async () => {
    let sent: unknown;
    const socket = fakeSocket((_event, payload, ack) => {
      sent = payload;
      setTimeout(() => ack({ stdout: 'done', stderr: '', exitCode: 0, timedOut: false }), 50);
    });
    registerDevice('dev-long', 'owner-1', '/root', socket);

    expect(await execOnDevice('dev-long', 'owner-1', 'leaf-1', 'sleep 999')).toMatchObject({ stdout: 'done', exitCode: 0 });
    expect(sent).toEqual({ leafId: 'leaf-1', command: 'sleep 999' });
    await execOnDevice('dev-long', 'owner-1', 'leaf-1', 'make', 90_000);
    expect(sent).toEqual({ leafId: 'leaf-1', command: 'make', timeoutMs: 90_000 });
  });

  it('ends a command when the device disconnects before answering, rather than waiting forever', async () => {
    const socket = fakeSocket((_event, _payload, _ack, disconnect) => { setTimeout(disconnect, 10); });
    registerDevice('dev-gone', 'owner-1', '/root', socket);

    const result = await execOnDevice('dev-gone', 'owner-1', 'leaf-1', 'sleep 999');
    expect(result).toMatchObject({ exitCode: -1, stderr: 'Local device dev-gone disconnected before it answered' });
  });
});

describe('readFileOnDevice / writeFileOnDevice', () => {
  it('reads a file back from the device', async () => {
    const socket = fakeSocket((event, _payload, ack) => {
      expect(event).toBe('sandbox:readFile');
      ack({ content: 'file contents' });
    });
    registerDevice('dev-read', 'owner-1', '/root', socket);

    expect(await readFileOnDevice('dev-read', 'owner-1', 'leaf-1', 'a.txt')).toBe('file contents');
  });

  it('rejects when the device reports an error reading', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack({ error: 'ENOENT' });
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
      ack({ error: 'disk full' });
    });
    registerDevice('dev-write-err', 'owner-1', '/root', socket);

    await expect(writeFileOnDevice('dev-write-err', 'owner-1', 'leaf-1', 'a.txt', 'x')).rejects.toThrow('disk full');
  });
});

describe('listDirOnDevice / deleteFileOnDevice', () => {
  it('resolves with the acked entries', async () => {
    const socket = fakeSocket((event, payload, ack) => {
      expect(event).toBe('sandbox:listDir');
      expect(payload).toEqual({ path: 'src' });
      ack({ entries: [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }] });
    });
    registerDevice('dev-list', 'owner-1', '/root', socket);

    const entries = await listDirOnDevice('dev-list', 'owner-1', 'src');
    expect(entries).toEqual([{ name: 'index.ts', path: 'src/index.ts', type: 'file' }]);
  });

  it('rejects when the device reports an error listing', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack({ error: 'ENOENT' });
    });
    registerDevice('dev-list-err', 'owner-1', '/root', socket);

    await expect(listDirOnDevice('dev-list-err', 'owner-1', 'ghost')).rejects.toThrow('ENOENT');
  });

  it('deletes a file and resolves on success', async () => {
    const socket = fakeSocket((event, payload, ack) => {
      expect(event).toBe('sandbox:deleteFile');
      expect(payload).toEqual({ path: 'a.txt' });
      ack(null);
    });
    registerDevice('dev-delete', 'owner-1', '/root', socket);

    await expect(deleteFileOnDevice('dev-delete', 'owner-1', 'a.txt')).resolves.toBeUndefined();
  });

  it('rejects when the device reports an error deleting', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack({ error: 'permission denied' });
    });
    registerDevice('dev-delete-err', 'owner-1', '/root', socket);

    await expect(deleteFileOnDevice('dev-delete-err', 'owner-1', 'a.txt')).rejects.toThrow('permission denied');
  });
});

describe('createContainerOnDevice / destroyContainerOnDevice', () => {
  it('sends the request and returns the acked containerMode', async () => {
    const socket = fakeSocket((event, payload, ack) => {
      expect(event).toBe('sandbox:createContainer');
      expect(payload).toEqual({ leafId: 'leaf-1', image: 'ubi9/nodejs-22' });
      ack({ containerMode: true });
    });
    registerDevice('dev-create', 'owner-1', '/root', socket);

    const result = await createContainerOnDevice('dev-create', 'owner-1', { leafId: 'leaf-1', image: 'ubi9/nodejs-22' });
    expect(result).toEqual({ containerMode: true });
  });

  it('resolves containerMode: false instead of throwing when the device goes away', async () => {
    const socket = fakeSocket((_event, _payload, _ack, disconnect) => { disconnect(); });
    registerDevice('dev-create-timeout', 'owner-1', '/root', socket);

    const result = await createContainerOnDevice('dev-create-timeout', 'owner-1', { leafId: 'leaf-1', image: 'x' });
    expect(result.containerMode).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('passes through a reported error alongside containerMode: false', async () => {
    const socket = fakeSocket((_event, _payload, ack) => {
      ack({ containerMode: false, error: 'Docker is not running' });
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
