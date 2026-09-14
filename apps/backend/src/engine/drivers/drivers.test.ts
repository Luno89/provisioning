import { describe, it, expect, vi } from 'vitest';
import { scopedPath, ScopeError } from '@koala/engine-core';
import { createNoneDriver, NoEnvironmentError } from '@koala/engine-core';
import { createMachineDriver, type MachineBackend } from './machine.js';
import { createSandboxDriver, type SandboxBackend } from './sandbox.js';
import { allowAll, createApprovalGate, denyAll } from '../approval.js';
import type { EnvironmentSpec } from '@koala/engine-core';

describe('scopedPath', () => {
  it('keeps a relative path inside the scope root', () => {
    expect(scopedPath({ path: 'apps/web' }, 'src/index.ts')).toBe('apps/web/src/index.ts');
  });

  it('prefers a worktree over the plain path so fan-out children stay apart', () => {
    expect(scopedPath({ path: 'apps/web', worktree: '.worktrees/child-1' }, 'src/index.ts'))
      .toBe('.worktrees/child-1/src/index.ts');
  });

  it('strips a leading slash rather than treating it as the real root', () => {
    expect(scopedPath({ path: 'apps/web' }, '/etc/passwd')).toBe('apps/web/etc/passwd');
  });

  it('refuses to climb out of the scope', () => {
    expect(() => scopedPath({ path: 'apps/web' }, '../../etc/passwd')).toThrow(ScopeError);
    expect(() => scopedPath({ path: 'apps/web' }, 'src/../../../secrets')).toThrow(ScopeError);
  });

  it('refuses to climb above the working directory when there is no scope', () => {
    expect(() => scopedPath(undefined, '../outside')).toThrow(ScopeError);
    expect(scopedPath(undefined, 'src/index.ts')).toBe('src/index.ts');
  });

  it('allows the scope root itself', () => {
    expect(scopedPath({ path: 'apps/web' }, '.')).toBe('apps/web');
  });
});

describe('none driver', () => {
  const driver = createNoneDriver();

  it('reports no capabilities', () => {
    expect(driver.handle().capabilities).toMatchObject({ terminal: false, filesystem: false, git: false });
  });

  it('refuses every operation with a readable reason', async () => {
    await expect(driver.exec({ command: 'ls' })).rejects.toThrow(NoEnvironmentError);
    await expect(driver.readFile('a.txt')).rejects.toThrow('cannot read files');
    await expect(driver.writeFile('a.txt', 'x')).rejects.toThrow('cannot write files');
    await expect(driver.listDir('.')).rejects.toThrow('cannot list directories');
    await expect(driver.deleteFile('a.txt')).rejects.toThrow('cannot delete files');
  });

  it('can still be allowed network access for a research-style agent', () => {
    expect(createNoneDriver({ egress: true }).handle().capabilities.egress).toBe(true);
  });
});

function machineBackend(): MachineBackend {
  return {
    exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => 'contents'),
    writeFile: vi.fn(async () => undefined),
    listDir: vi.fn(async () => [{ name: 'src', type: 'dir' as const }]),
    deleteFile: vi.fn(async () => undefined),
  };
}

const machine = (over: Partial<Parameters<typeof createMachineDriver>[0]> = {}) => {
  const backend = machineBackend();
  const driver = createMachineDriver({
    deviceId: 'tallgeese',
    deviceName: 'Tallgeese',
    ownerId: 'user-1',
    runId: 'run-1',
    agentSlug: 'executor',
    scope: { path: 'projects/thing' },
    backend,
    approval: allowAll(),
    ...over,
  });
  return { driver, backend };
};

describe('machine driver', () => {
  it('is persistent, command-approved, and scoped to the device path', () => {
    const { driver } = machine();
    const handle = driver.handle();

    expect(handle.spec).toMatchObject({ kind: 'machine', lifecycle: 'persistent' });
    expect(handle.approval).toBe('per-command');
    expect(handle.scope).toMatchObject({ deviceId: 'tallgeese', path: 'projects/thing' });
  });

  it('asks for approval before running anything', async () => {
    const decide = vi.fn(async () => 'allow' as const);
    const { driver, backend } = machine({ approval: createApprovalGate({ decide }) });

    await driver.exec({ command: 'npm test' });

    expect(decide).toHaveBeenCalledTimes(1);
    expect(backend.exec).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm test', cwd: 'projects/thing' }));
  });

  it('does not run the command at all when approval is declined', async () => {
    const { driver, backend } = machine({ approval: denyAll() });

    const result = await driver.exec({ command: 'rm -rf /' });

    expect(backend.exec).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toMatch(/declined/i);
  });

  it('confines file operations to the scoped path', async () => {
    const { driver, backend } = machine();

    await driver.readFile('src/index.ts');
    await driver.writeFile('notes.md', 'hi');
    await driver.listDir('.');
    await driver.deleteFile('tmp/junk');

    expect(backend.readFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'projects/thing/src/index.ts' }));
    expect(backend.writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'projects/thing/notes.md' }));
    expect(backend.listDir).toHaveBeenCalledWith(expect.objectContaining({ path: 'projects/thing' }));
    expect(backend.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'projects/thing/tmp/junk' }));
  });

  it('refuses a path that escapes the scope before reaching the device', async () => {
    const { driver, backend } = machine();

    await expect(driver.readFile('../../.ssh/id_rsa')).rejects.toThrow(ScopeError);
    expect(backend.readFile).not.toHaveBeenCalled();
  });

  it('runs a fan-out child inside its own worktree', async () => {
    const { driver, backend } = machine({ scope: { path: 'projects/thing', worktree: '.worktrees/child-2' } });

    await driver.exec({ command: 'npm test' });
    await driver.readFile('src/a.ts');

    expect(backend.exec).toHaveBeenCalledWith(expect.objectContaining({ cwd: '.worktrees/child-2' }));
    expect(backend.readFile).toHaveBeenCalledWith(expect.objectContaining({ path: '.worktrees/child-2/src/a.ts' }));
  });
});

function sandboxBackend(over: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => 'contents'),
    writeFile: vi.fn(async () => undefined),
    listDir: vi.fn(async () => []),
    deleteFile: vi.fn(async () => undefined),
    ...over,
  };
}

const spec: EnvironmentSpec = { kind: 'sandbox', lifecycle: 'invocation', languages: ['node20'] };

describe('sandbox driver', () => {
  it('never asks for approval', async () => {
    const backend = sandboxBackend();
    const driver = createSandboxDriver({ sandboxId: 'sb-1', spec, backend });

    expect(driver.handle().approval).toBe('none');
    await driver.exec({ command: 'npm ci' });
    expect(backend.exec).toHaveBeenCalled();
  });

  it('scopes paths when it has a scope', async () => {
    const backend = sandboxBackend();
    const driver = createSandboxDriver({ sandboxId: 'sb-1', spec, scope: { path: 'work' }, backend });

    await driver.readFile('src/a.ts');
    expect(backend.readFile).toHaveBeenCalledWith({ sandboxId: 'sb-1', path: 'work/src/a.ts' });
  });

  it('exposes checkpoint, restore and dispose only when the backend supports them', async () => {
    const plain = createSandboxDriver({ sandboxId: 'sb-1', spec, backend: sandboxBackend() });
    expect(plain.checkpoint).toBeUndefined();
    expect(plain.restore).toBeUndefined();
    expect(plain.dispose).toBeUndefined();

    const snapshot = vi.fn(async () => 'snap-1');
    const restore = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const capable = createSandboxDriver({
      sandboxId: 'sb-2',
      spec,
      backend: sandboxBackend({ snapshot, restore, destroy }),
    });

    expect(await capable.checkpoint?.()).toBe('snap-1');
    await capable.restore?.('snap-1');
    await capable.dispose?.();

    expect(restore).toHaveBeenCalledWith({ sandboxId: 'sb-2', reference: 'snap-1' });
    expect(destroy).toHaveBeenCalledWith({ sandboxId: 'sb-2' });
  });
});
