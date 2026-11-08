import { describe, expect, it, vi } from 'vitest';
import type { KubeResult, KubeRunner } from '../../engine-host/sandboxes/kube.js';
import { WORKSPACE_IMAGE_SEEDS } from '../lib/workspace-image-seeds.js';
import { workspaceNamespace, WORKSPACE_MOUNT, WORKSPACE_POD } from '../lib/workspace-spec.js';
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_OUTPUT_CHARS, WorkspaceService } from './WorkspaceService.js';

const answers = (...results: Partial<KubeResult>[]) => {
  const kube = vi.fn<KubeRunner>();
  for (const result of results) kube.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, ...result });
  return kube;
};

const namespace = workspaceNamespace('leaf-1');

describe('a leaf workspace run on Koala\'s own cluster', () => {
  it('runs a command in the workspace pod with the default limit, keeping all it printed to judge whether it was cut', async () => {
    const kube = answers({ stdout: 'x'.repeat(MAX_OUTPUT_CHARS + 1), stderr: 'warned', exitCode: 2 });
    const result = await new WorkspaceService(kube).exec('leaf-1', 'make', undefined, ['a']);
    expect(kube).toHaveBeenCalledWith(['exec', WORKSPACE_POD, '-n', namespace, '-i', '--', 'sh', '-c', 'make', 'a'], undefined, DEFAULT_EXEC_TIMEOUT_MS, { outputChars: Infinity });
    expect(result).toEqual({ stdout: 'x'.repeat(MAX_OUTPUT_CHARS), stderr: 'warned', exitCode: 2, timedOut: false, truncated: true });
  });

  it('says a command was stopped at its limit, and was not cut when it printed little', async () => {
    const kube = answers({ stdout: 'part', exitCode: 128, stopped: 'timeout' });
    expect(await new WorkspaceService(kube).exec('leaf-1', 'sleep 9', 50)).toEqual({ stdout: 'part', stderr: '', exitCode: 128, timedOut: true, truncated: false });
    expect(kube.mock.calls[0]?.[2]).toBe(50);
  });

  it('writes a file inside the workspace as base64 on the command\'s input, and refuses a path that leaves it', async () => {
    const kube = answers({});
    const workspaces = new WorkspaceService(kube);
    await workspaces.writeFile('leaf-1', 'notes/a.md', 'hello');
    expect(kube.mock.calls[0]?.[0]).toEqual(['exec', WORKSPACE_POD, '-n', namespace, '-i', '--', 'sh', '-c', 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', 'sh', `${WORKSPACE_MOUNT}/notes/a.md`]);
    expect(kube.mock.calls[0]?.[1]).toBe(Buffer.from('hello').toString('base64'));
    await expect(workspaces.writeFile('leaf-1', '../etc/passwd', 'x')).rejects.toThrow('escapes the workspace');
  });

  it('fails a write the pod refused, with what it said', async () => {
    await expect(new WorkspaceService(answers({ exitCode: 1, stderr: 'read-only' })).writeFile('leaf-1', 'a', 'x')).rejects.toThrow('Could not write a: read-only');
  });

  it('reads a file back decoded, and fails a read the pod refused', async () => {
    expect(await new WorkspaceService(answers({ stdout: Buffer.from('é text').toString('base64') })).readFile('leaf-1', 'a')).toBe('é text');
    await expect(new WorkspaceService(answers({ exitCode: 1, stderr: 'no such file' })).readFile('leaf-1', 'a')).rejects.toThrow('Could not read a: no such file');
  });

  it('creates the workspace once its namespace is gone, and removes it again when it never became ready', async () => {
    const kube = answers({ exitCode: 1 }, {}, { exitCode: 1, stderr: 'timed out waiting' }, {});
    await expect(new WorkspaceService(kube).create({ leafId: 'leaf-1', ownerId: 'o' }, 1_000, WORKSPACE_IMAGE_SEEDS)).rejects.toThrow(`Workspace ${namespace} never became ready: timed out waiting`);
    expect(kube.mock.calls.map((call) => call[0][0])).toEqual(['get', 'apply', 'wait', 'delete']);
    expect(kube.mock.calls[1]?.[1]).toContain('"kind":"Namespace"');
  });

  it('fails a create the cluster refused', async () => {
    const kube = answers({ exitCode: 1 }, { exitCode: 1, stderr: 'forbidden' });
    await expect(new WorkspaceService(kube).create({ leafId: 'leaf-1', ownerId: 'o' }, undefined, WORKSPACE_IMAGE_SEEDS)).rejects.toThrow(`Could not create workspace ${namespace}: forbidden`);
  });

  it('says whether the workspace pod is running', async () => {
    expect(await new WorkspaceService(answers({ stdout: 'Running' })).isRunning('leaf-1')).toBe(true);
    expect(await new WorkspaceService(answers({ stdout: 'Pending' })).isRunning('leaf-1')).toBe(false);
    expect(await new WorkspaceService(answers({ exitCode: 1, stdout: 'Running' })).isRunning('leaf-1')).toBe(false);
  });

  it('reads a binding\'s credentials through the cluster, and says why when the Secret cannot be read', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = { name: 'db', type: 'postgres', host: 'db', port: 5432, source: { secretName: 'db-creds', namespace: 'shop', keys: { password: 'pw' } } };
    const secret = JSON.stringify({ data: { pw: Buffer.from('s3cret').toString('base64') } });
    const read = answers({ stdout: secret });
    const [files] = await new WorkspaceService(read).materializeBindings([binding]);
    expect(read.mock.calls[0]?.[0]).toEqual(['get', 'secret', 'db-creds', '-n', 'shop', '-o', 'json']);
    expect(files?.name).toBe('db');
    expect(files?.files.password).toBe('s3cret');

    await new WorkspaceService(answers({ exitCode: 1, stderr: 'secrets "db-creds" is forbidden' })).materializeBindings([binding]);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('the credentials of db could not be read from db-creds: secrets "db-creds" is forbidden'));
    warned.mockRestore();
  });
});
