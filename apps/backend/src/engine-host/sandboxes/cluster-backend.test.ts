import { describe, it, expect, vi } from 'vitest';
import { createClusterBackend, WorkspaceUnavailableError } from './cluster-backend.js';
import { workspaceName, type RunWorkspace } from './workspace.js';
import type { KubeResult, KubeRunner } from './kube.js';

const workspace: RunWorkspace = {
  runId: 'run-abc',
  ownerId: 'user-1',
  agent: 'executor',
  image: 'registry.access.redhat.com/ubi9/nodejs-22',
  provides: ['bash', 'git', 'node', 'npm', 'python3'],
  egressMode: 'declared',
  lifetimeMs: 30 * 60_000,
  cpu: '2',
  memory: '2Gi',
  egress: [{ namespace: 'koala-registry', ports: [4873] }],
  env: [{ name: 'NPM_CONFIG_REGISTRY', value: 'http://verdaccio.koala-registry.svc.cluster.local:4873' }],
};

const NAMESPACE = workspaceName('run-abc');

function kube(script: Partial<Record<string, KubeResult>> = {}, fallback?: KubeResult) {
  const calls: { args: string[]; input?: string | undefined }[] = [];

  const run: KubeRunner = vi.fn(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    const verb = args[0] ?? '';
    return script[verb] ?? fallback ?? { stdout: '', stderr: '', exitCode: 0 };
  });

  return { run, calls };
}

const notRunning: KubeResult = { stdout: '', stderr: 'NotFound', exitCode: 1 };
const running: KubeResult = { stdout: 'Running', stderr: '', exitCode: 0 };

describe('standing a workspace up', () => {
  it('creates nothing until something actually reaches for it', () => {
    const { run, calls } = kube();
    createClusterBackend({ run, workspace });

    expect(calls).toHaveLength(0);
  });

  it('applies its own manifests, waits for the pod, then reuses it', async () => {
    const { run, calls } = kube({ get: notRunning });
    const backend = createClusterBackend({ run, workspace });

    await backend.exec({ sandboxId: 'ignored', command: 'echo one' });
    await backend.exec({ sandboxId: 'ignored', command: 'echo two' });

    const verbs = calls.map((call) => call.args[0]);
    expect(verbs.filter((verb) => verb === 'apply')).toHaveLength(1);
    expect(verbs.filter((verb) => verb === 'wait')).toHaveLength(1);
    expect(verbs.filter((verb) => verb === 'exec')).toHaveLength(2);
  });

  it('names the namespace after the run, not after anything older', async () => {
    const { run, calls } = kube({ get: notRunning });
    await createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'echo' });

    expect(NAMESPACE).toBe('koala-run-run-abc');
    expect(calls.some((call) => call.args.includes(NAMESPACE))).toBe(true);
  });

  it('applies a manifest carrying the image, its package env and its egress', async () => {
    const { run, calls } = kube({ get: notRunning });
    await createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'echo' });

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('ubi9/nodejs-22');
    expect(applied).toContain('NPM_CONFIG_REGISTRY');
    expect(applied).toContain('koala-registry');
    expect(applied).toContain('"koala.dev/run":"run-abc"');
  });

  it('gives the pod a deadline matching the run, not a fixed hour', async () => {
    const { run, calls } = kube({ get: notRunning });
    const long = { ...workspace, lifetimeMs: 4 * 60 * 60_000 };
    await createClusterBackend({ run, workspace: long }).exec({ sandboxId: 'x', command: 'echo' });

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('"activeDeadlineSeconds":14400');
    expect(applied).not.toContain('"activeDeadlineSeconds":3600');
  });

  it('adopts a pod that is already up rather than applying again', async () => {
    const { run, calls } = kube({ get: running });
    await createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'echo' });

    expect(calls.some((call) => call.args[0] === 'apply')).toBe(false);
  });

  it('explains a workspace that will not start', async () => {
    const { run } = kube({ get: notRunning, apply: { stdout: '', stderr: 'quota exceeded', exitCode: 1 } });

    await expect(createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'echo' }))
      .rejects.toThrow(WorkspaceUnavailableError);
  });

  it('explains a pod that never becomes ready', async () => {
    const { run } = kube({ get: notRunning, wait: { stdout: '', stderr: 'timed out', exitCode: 1 } });

    await expect(createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'echo' }))
      .rejects.toThrow(/never became ready/);
  });
});

describe('working inside it', () => {
  const ready = () => kube({ get: running });

  it('runs a command in the directory it was given', async () => {
    const { run, calls } = ready();
    await createClusterBackend({ run, workspace })
      .exec({ sandboxId: 'x', command: 'npm test', cwd: 'apps/web' });

    expect(calls.at(-1)?.args).toContain("cd 'apps/web' && npm test");
  });

  it('quotes a path so a quote in it cannot break out of the command', async () => {
    const { run, calls } = ready();
    await createClusterBackend({ run, workspace })
      .exec({ sandboxId: 'x', command: 'ls', cwd: "it's here" });

    expect(calls.at(-1)?.args).toContain("cd 'it'\\''s here' && ls");
  });

  it('writes a file as base64 so its content cannot be mangled by the shell', async () => {
    const { run, calls } = ready();
    await createClusterBackend({ run, workspace })
      .writeFile({ sandboxId: 'x', path: 'a.ts', content: 'const x = "hi";\n' });

    const write = calls.at(-1);
    expect(write?.input).toBe(Buffer.from('const x = "hi";\n', 'utf8').toString('base64'));
    expect(write?.args).toContain('a.ts');
  });

  it('lists a directory, telling files from folders and hiding .git', async () => {
    const { run } = kube({ get: running }, { stdout: 'src/\n.git/\npackage.json\n', stderr: '', exitCode: 0 });

    const entries = await createClusterBackend({ run, workspace }).listDir({ sandboxId: 'x', path: '.' });

    expect(entries).toEqual([
      { name: 'src', type: 'dir' },
      { name: 'package.json', type: 'file' },
    ]);
  });

  it('surfaces why a read failed rather than returning nothing', async () => {
    const { run } = kube({ get: running }, { stdout: '', stderr: 'No such file', exitCode: 1 });

    await expect(createClusterBackend({ run, workspace }).readFile({ sandboxId: 'x', path: 'nope' }))
      .rejects.toThrow(/No such file/);
  });

  it('deletes the whole namespace on teardown, so nothing is left behind', async () => {
    const { run, calls } = ready();
    await createClusterBackend({ run, workspace }).destroy!({ sandboxId: 'x' });

    expect(calls.at(-1)?.args).toEqual([
      'delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=false',
    ]);
  });
});

describe('a workspace that outlives its pod', () => {
  const kept: RunWorkspace = { ...workspace, runId: 'tree-t1', persistent: true };

  it('keeps the work on a claimed volume, not on the pod', async () => {
    const { run, calls } = kube({ get: notRunning });
    await createClusterBackend({ run, workspace: kept }).exec({ sandboxId: 'x', command: 'echo' });

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('"kind":"PersistentVolumeClaim"');
    expect(applied).toContain('"persistentVolumeClaim":{"claimName":"work"}');
    expect(applied).not.toContain('"name":"work","emptyDir"');
  });

  it('a run-owned workspace stays on scratch space', async () => {
    const { run, calls } = kube({ get: notRunning });
    await createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'echo' });

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).not.toContain('PersistentVolumeClaim');
  });

  it('brings a pod back over the same volume after it was parked or ran out its deadline', async () => {
    let phase: KubeResult = notRunning;
    const calls: string[][] = [];
    const run: KubeRunner = vi.fn(async (args) => {
      calls.push(args);
      if (args[0] === 'get') return phase;
      if (args[0] === 'wait') phase = running;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = createClusterBackend({ run, workspace: kept });

    await backend.exec({ sandboxId: 'x', command: 'echo one' });
    phase = notRunning;
    await backend.exec({ sandboxId: 'x', command: 'echo two' });

    const verbs = calls.map((args) => args.slice(0, 2).join(' '));
    expect(verbs.filter((verb) => verb === 'delete pod')).toHaveLength(2);
    expect(verbs.filter((verb) => verb.startsWith('apply'))).toHaveLength(2);
    expect(verbs.some((verb) => verb === 'delete namespace')).toBe(false);
  });
});
