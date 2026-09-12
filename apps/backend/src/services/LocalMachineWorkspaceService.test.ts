import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { MemoryDB } from '../lib/memory-db.js';
import { registerDevice } from '../lib/local-agent-registry.js';
import { LocalMachineWorkspaceService } from './LocalMachineWorkspaceService.js';

function fakeSocket(handler: (event: string, payload: unknown, ack: (...args: any[]) => void) => void): Socket {
  return {
    timeout: () => ({
      emit: (event: string, payload: unknown, ack: (...args: any[]) => void) => handler(event, payload, ack),
    }),
  } as unknown as Socket;
}

async function db() {
  const d = new MemoryDB();
  await d.init();
  return d;
}

describe('LocalMachineWorkspaceService — auto mode', () => {
  it('exec delegates to the device connection and returns its result', async () => {
    registerDevice('dev-a', 'owner-a', '/root', fakeSocket((_event, _payload, ack) => {
      ack(null, { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false });
    }));

    const service = new LocalMachineWorkspaceService('dev-a', 'owner-a', { db: await db(), approvalMode: 'auto' });
    const result = await service.exec('leaf-1', 'echo ok');
    expect(result.stdout).toBe('ok');
  });

  it('create asks the device to create a container and confirms the device id', async () => {
    let sent: unknown;
    registerDevice('dev-b', 'owner-a', '/root', fakeSocket((event, payload, ack) => {
      sent = { event, payload };
      ack(null, { containerMode: true });
    }));

    const service = new LocalMachineWorkspaceService('dev-b', 'owner-a', { db: await db(), approvalMode: 'auto' });
    await expect(service.create({ leafId: 'leaf-1', ownerId: 'owner-a', image: 'ubi9/nodejs-22' })).resolves.toBe('dev-b');
    expect(sent).toEqual({ event: 'sandbox:createContainer', payload: { leafId: 'leaf-1', image: 'ubi9/nodejs-22' } });
    expect(service.executionKind()).toBe('local-container');
  });

  it('create falls back to local-device mode when the agent reports no container support', async () => {
    registerDevice('dev-b2', 'owner-a', '/root', fakeSocket((_event, _payload, ack) => {
      ack(null, { containerMode: false });
    }));

    const service = new LocalMachineWorkspaceService('dev-b2', 'owner-a', { db: await db(), approvalMode: 'auto' });
    await service.create({ leafId: 'leaf-1', ownerId: 'owner-a' });
    expect(service.executionKind()).toBe('local-device');
  });

  it('create rejects when the device is not connected at all — the leaf genuinely cannot run', async () => {
    const service = new LocalMachineWorkspaceService('dev-offline', 'owner-a', { db: await db(), approvalMode: 'auto' });
    await expect(service.create({ leafId: 'leaf-1', ownerId: 'owner-a' })).rejects.toThrow(/not connected/);
  });

  it('passes egress and resource limits from options into the container-create request', async () => {
    let sent: any;
    registerDevice('dev-b3', 'owner-a', '/root', fakeSocket((event, payload, ack) => {
      sent = { event, payload };
      ack(null, { containerMode: true });
    }));

    const service = new LocalMachineWorkspaceService('dev-b3', 'owner-a', {
      db: await db(), approvalMode: 'auto', egress: [{ host: 'registry.npmjs.org' }], cpu: '4', memory: '8Gi',
    });
    await service.create({ leafId: 'leaf-1', ownerId: 'owner-a', image: 'ubi9/nodejs-22' });
    expect(sent.payload).toEqual({
      leafId: 'leaf-1', image: 'ubi9/nodejs-22', cpu: '4', memory: '8Gi', egress: [{ host: 'registry.npmjs.org' }],
    });
  });

  it('refuses to write outside the device root via an absolute path', async () => {
    registerDevice('dev-c', 'owner-a', '/root', fakeSocket(() => {
      throw new Error('should never reach the device');
    }));
    const service = new LocalMachineWorkspaceService('dev-c', 'owner-a', { db: await db(), approvalMode: 'auto' });
    await expect(service.writeFile('leaf-1', '/etc/passwd', 'x')).rejects.toThrow(/must be relative/);
  });

  it('scopes exec to the project subfolder when opts.path is set', async () => {
    let sent: any;
    registerDevice('dev-path', 'owner-a', '/root', fakeSocket((event, payload, ack) => {
      sent = { event, payload };
      ack(null, { stdout: '', stderr: '', exitCode: 0, timedOut: false });
    }));

    const service = new LocalMachineWorkspaceService('dev-path', 'owner-a', { db: await db(), approvalMode: 'auto', path: 'apps/thing' });
    await service.exec('leaf-1', 'echo hi');
    expect(sent).toEqual({ event: 'sandbox:exec', payload: { leafId: 'leaf-1', command: 'echo hi', cwd: 'apps/thing' } });
  });

  it('does not send a cwd when the project has no subfolder', async () => {
    let sent: any;
    registerDevice('dev-nopath', 'owner-a', '/root', fakeSocket((event, payload, ack) => {
      sent = { event, payload };
      ack(null, { stdout: '', stderr: '', exitCode: 0, timedOut: false });
    }));

    const service = new LocalMachineWorkspaceService('dev-nopath', 'owner-a', { db: await db(), approvalMode: 'auto' });
    await service.exec('leaf-1', 'echo hi');
    expect(sent.payload).toEqual({ leafId: 'leaf-1', command: 'echo hi' });
  });

  it('prefixes file reads and writes with the project subfolder', async () => {
    let sent: any;
    registerDevice('dev-file-path', 'owner-a', '/root', fakeSocket((event, payload, ack) => {
      sent = { event, payload };
      ack(null, { content: 'hi' });
    }));

    const service = new LocalMachineWorkspaceService('dev-file-path', 'owner-a', { db: await db(), approvalMode: 'auto', path: 'apps/thing' });
    await service.readFile('leaf-1', 'src/index.ts');
    expect(sent.payload).toEqual({ leafId: 'leaf-1', path: 'apps/thing/src/index.ts' });
  });

  it('destroy and isRunning are safe no-ops', async () => {
    const service = new LocalMachineWorkspaceService('dev-d', 'owner-a', { db: await db(), approvalMode: 'auto' });
    await expect(service.destroy('leaf-1')).resolves.toBeUndefined();
    await expect(service.isRunning('leaf-1')).resolves.toBe(true);
  });
});

describe('LocalMachineWorkspaceService — plan mode', () => {
  it('requests approval and waits before dispatching an exec', async () => {
    const memdb = await db();
    let dispatched = false;
    registerDevice('dev-plan', 'owner-a', '/root', fakeSocket((_event, _payload, ack) => {
      dispatched = true;
      ack(null, { stdout: 'ran', stderr: '', exitCode: 0, timedOut: false });
    }));

    const service = new LocalMachineWorkspaceService('dev-plan', 'owner-a', { db: memdb, approvalMode: 'plan', projectId: 'proj-1', approvalPollIntervalMs: 5 });
    const execPromise = service.exec('leaf-1', 'echo hi');

    await vi.waitFor(async () => expect(await memdb.getPendingApprovals()).toHaveLength(1));
    expect(dispatched).toBe(false);

    const [pending] = await memdb.getPendingApprovals();
    expect(pending).toMatchObject({ leafId: 'leaf-1', projectId: 'proj-1', command: 'echo hi', status: 'pending' });
    await memdb.savePendingApproval({ ...pending!, status: 'approved' });

    const result = await execPromise;
    expect(dispatched).toBe(true);
    expect(result.stdout).toBe('ran');
  });

  it('never reaches the device when the command is denied', async () => {
    const memdb = await db();
    registerDevice('dev-deny', 'owner-a', '/root', fakeSocket(() => {
      throw new Error('should never reach the device');
    }));

    const service = new LocalMachineWorkspaceService('dev-deny', 'owner-a', { db: memdb, approvalMode: 'plan', approvalPollIntervalMs: 5 });
    const execPromise = service.exec('leaf-1', 'rm -rf /');

    await vi.waitFor(async () => expect(await memdb.getPendingApprovals()).toHaveLength(1));
    const [pending] = await memdb.getPendingApprovals();
    await memdb.savePendingApproval({ ...pending!, status: 'denied' });

    const result = await execPromise;
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/denied by a human reviewer/);
  });

  it('gates writeFile the same way, throwing when denied', async () => {
    const memdb = await db();
    registerDevice('dev-write-deny', 'owner-a', '/root', fakeSocket(() => {
      throw new Error('should never reach the device');
    }));

    const service = new LocalMachineWorkspaceService('dev-write-deny', 'owner-a', { db: memdb, approvalMode: 'plan', approvalPollIntervalMs: 5 });
    const writePromise = service.writeFile('leaf-1', 'a.txt', 'hello');

    await vi.waitFor(async () => expect(await memdb.getPendingApprovals()).toHaveLength(1));
    const [pending] = await memdb.getPendingApprovals();
    expect(pending!.command).toMatch(/^write file: a\.txt/);
    await memdb.savePendingApproval({ ...pending!, status: 'denied' });

    await expect(writePromise).rejects.toThrow(/denied by a human reviewer/);
  });

  it('calls the heartbeat callback while waiting', async () => {
    const memdb = await db();
    registerDevice('dev-beat', 'owner-a', '/root', fakeSocket((_event, _payload, ack) => ack(null, { stdout: '', stderr: '', exitCode: 0, timedOut: false })));

    const onHeartbeat = vi.fn();
    const service = new LocalMachineWorkspaceService('dev-beat', 'owner-a', {
      db: memdb, approvalMode: 'plan', onHeartbeat, approvalPollIntervalMs: 5,
    });
    const execPromise = service.exec('leaf-1', 'echo hi');

    await vi.waitFor(() => expect(onHeartbeat).toHaveBeenCalled());
    expect(onHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ phase: 'awaiting-approval' }));

    const [pending] = await memdb.getPendingApprovals();
    await memdb.savePendingApproval({ ...pending!, status: 'approved' });
    await execPromise;
  });
});
