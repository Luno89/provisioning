import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createClusterBackend, GROUPED_EXEC, STOP_GROUPED_EXEC, WorkspaceUnavailableError } from './cluster-backend.js';
import { workspaceName, type RunWorkspace } from './workspace.js';
import type { KubeResult, KubeRunner } from './kube.js';
import { workspaceStamp } from '../../engine/lib/published-workspace.js';

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
    const verb = args[0] === 'get' && args.includes('json') ? 'ready' : args[0] ?? '';
    return script[verb] ?? (verb === 'ready' ? readyPod : undefined) ?? fallback ?? { stdout: '', stderr: '', exitCode: 0 };
  });

  return { run, calls };
}

const podSaying = (status: object): KubeResult => ({ stdout: JSON.stringify({ metadata: { name: 'workspace' }, status }), stderr: '', exitCode: 0 });
const readyPod = podSaying({ phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: {} }] });
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
    expect(calls.filter((call) => call.args[0] === 'get' && call.args.includes('json'))).toHaveLength(1);
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

  it('pulls the workspace image with the registry login it is handed, and asks for none without one', async () => {
    const login = { hosts: { push: '10.0.0.130:31737', pull: '10.0.0.130:31737' }, username: 'provisioning-bot', password: 'tok' };
    const withLogin = kube({ get: notRunning });
    await createClusterBackend({ run: withLogin.run, workspace, registry: async () => login }).exec({ sandboxId: 'x', command: 'echo' });
    const docs = (withLogin.calls.find((call) => call.args[0] === 'apply')?.input ?? '').split('\n---\n').map((doc) => JSON.parse(doc));
    expect(docs.find((doc) => doc.kind === 'Secret')).toMatchObject({ type: 'kubernetes.io/dockerconfigjson', metadata: { name: 'koala-registry-pull', namespace: NAMESPACE } });
    expect(docs.find((doc) => doc.kind === 'Pod').spec.imagePullSecrets).toEqual([{ name: 'koala-registry-pull' }]);

    const without = kube({ get: notRunning });
    await createClusterBackend({ run: without.run, workspace }).exec({ sandboxId: 'x', command: 'echo' });
    expect(without.calls.find((call) => call.args[0] === 'apply')?.input ?? '').not.toContain('imagePullSecrets');
  });

  it('gives the pod a deadline matching the run, not a fixed hour', async () => {
    const { run, calls } = kube({ get: notRunning });
    const long = { ...workspace, lifetimeMs: 4 * 60 * 60_000 };
    await createClusterBackend({ run, workspace: long }).exec({ sandboxId: 'x', command: 'echo' });

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('"activeDeadlineSeconds":14400');
    expect(applied).toContain('"terminationGracePeriodSeconds":1');
    expect(applied).not.toContain('"activeDeadlineSeconds":3600');
  });

  it('gives a pod no deadline at all when the run sets no time budget, so it lasts as long as the run', async () => {
    const { run, calls } = kube({ get: notRunning });
    const { lifetimeMs: _none, ...open } = workspace;
    await createClusterBackend({ run, workspace: open }).exec({ sandboxId: 'x', command: 'echo' });

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).not.toContain('activeDeadlineSeconds');
    expect(applied).toContain('"command":["sleep","infinity"]');
  });

  it('keeps waiting for a pod that is still pulling its image, however long that takes', async () => {
    let asked = 0;
    const run: KubeRunner = vi.fn(async (args) => {
      if (args[0] === 'get' && args.includes('json')) {
        asked += 1;
        return asked < 4 ? podSaying({ phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } }] }) : readyPod;
      }
      if (args[0] === 'get') return args.includes('json') ? readyPod : notRunning;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await createClusterBackend({ run, workspace, readyPollMs: 1 }).exec({ sandboxId: 'x', command: 'echo' });

    expect(asked).toBe(4);
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

  it('explains a pod that can never start, rather than waiting on it', async () => {
    const { run } = kube({ get: notRunning, ready: podSaying({ phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } }] }) });

    await expect(createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'echo' }))
      .rejects.toThrow(/cannot start: workspace: ImagePullBackOff/);
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

  it('reads a file whole, however long it is, with its characters intact', async () => {
    const text = `${'é'.repeat(20_000)}\n${'x'.repeat(40_000)}\n`;
    const bytes = Buffer.from(text, 'utf8');
    const { run, calls } = kube({ get: running }, { stdout: `${bytes.length}\n${bytes.toString('base64')}`, stderr: '', exitCode: 0 });

    expect(await createClusterBackend({ run, workspace }).readFile({ sandboxId: 'x', path: 'big.txt' })).toBe(text);
    expect(calls.at(-1)?.args.slice(-2)).toEqual(['sh', 'big.txt']);
  });

  it('refuses a file that came back short rather than handing over part of it', async () => {
    const { run } = kube({ get: running }, { stdout: `100000\n${Buffer.from('only some').toString('base64')}`, stderr: '', exitCode: 0 });

    await expect(createClusterBackend({ run, workspace }).readFile({ sandboxId: 'x', path: 'big.txt' }))
      .rejects.toThrow('big.txt came back as 9 of 100000 bytes, so it was not read whole');
  });

  it('reads an empty file as empty', async () => {
    const { run } = kube({ get: running }, { stdout: '0\n', stderr: '', exitCode: 0 });

    expect(await createClusterBackend({ run, workspace }).readFile({ sandboxId: 'x', path: 'empty' })).toBe('');
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
      if (args[0] === 'get' && args.includes('json')) { phase = running; return readyPod; }
      if (args[0] === 'get') return phase;
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

describe('a kept workspace whose image was rebuilt', () => {
  const kept: RunWorkspace = { ...workspace, runId: 'tree-t1', persistent: true };
  const standing = (image: string): KubeResult => ({ stdout: `Running\t${workspaceStamp({ ...kept, image })}`, stderr: '', exitCode: 0 });

  it('carries a stamp of its image and environment on the pod', async () => {
    const { run, calls } = kube({ get: notRunning });
    await createClusterBackend({ run, workspace: kept }).exec({ sandboxId: 'x', command: 'echo' });
    expect(calls.find((call) => call.args[0] === 'apply')?.input).toContain(`"koala.dev/workspace":"${workspaceStamp(kept)}"`);
  });

  it('goes on in the pod it has while the image is the same', async () => {
    const { run, calls } = kube({ get: standing(kept.image) });
    await createClusterBackend({ run, workspace: kept }).exec({ sandboxId: 'x', command: 'echo' });
    expect(calls.some((call) => call.args[0] === 'apply')).toBe(false);
  });

  it('is brought back on the new image over the same volume, when the one running is older', async () => {
    const { run, calls } = kube({ get: standing('registry/koala/workspace:old') });
    await createClusterBackend({ run, workspace: kept }).exec({ sandboxId: 'x', command: 'echo' });
    const verbs = calls.map((call) => call.args.slice(0, 2).join(' '));
    expect(verbs).toContain('delete pod');
    expect(verbs.some((verb) => verb.startsWith('apply'))).toBe(true);
    expect(verbs).not.toContain('delete namespace');
  });

  it('keeps a pod started before stamps existed, rather than replacing every workspace at once', async () => {
    const { run, calls } = kube({ get: running });
    await createClusterBackend({ run, workspace: kept }).exec({ sandboxId: 'x', command: 'echo' });
    expect(calls.some((call) => call.args[0] === 'apply')).toBe(false);
  });
});

describe('a workspace several runs share', () => {
  it('is started once when they all reach for it at the same moment, and its files are restored once', async () => {
    let applied = 0;
    const run: KubeRunner = vi.fn(async (args) => {
      if (args[0] === 'apply') { applied += 1; await new Promise((resolve) => setTimeout(resolve, 30)); }
      if (args[0] === 'get') return args.includes('json') ? readyPod : applied > 0 ? running : notRunning;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    let restored = 0;
    const shared = { ...workspace, runId: 'conversation-c1', persistent: true };
    const backends = [1, 2, 3].map(() => createClusterBackend({ run, workspace: shared, onStarted: async () => { restored += 1; } }));

    await Promise.all(backends.map((backend) => backend.writeFile({ sandboxId: 's', path: 'a.md', content: 'x' })));

    expect(applied).toBe(1);
    expect(restored).toBe(1);
  });

  it('applies again when another process created it first', async () => {
    let attempts = 0;
    const run: KubeRunner = vi.fn(async (args) => {
      if (args[0] === 'apply') {
        attempts += 1;
        return attempts === 1 ? { stdout: '', stderr: 'Error from server (AlreadyExists): persistentvolumeclaims "work" already exists', exitCode: 1 } : { stdout: 'configured', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'get') return args.includes('json') ? readyPod : attempts > 1 ? running : notRunning;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await createClusterBackend({ run, workspace: { ...workspace, runId: 'conversation-c2', persistent: true } }).writeFile({ sandboxId: 's', path: 'a.md', content: 'x' });
    expect(attempts).toBe(2);
  });
});

describe('a command that may run long', () => {
  it('runs in its own process group with no time limit, and stopping it stops that group in the pod first', async () => {
    const calls: { args: string[]; timeoutMs?: number | undefined; options?: Record<string, unknown> | undefined }[] = [];
    const stop = new AbortController();
    const run: KubeRunner = vi.fn(async (args, _input, timeoutMs, options) => {
      calls.push({ args, timeoutMs, options: options as never });
      if (args[0] === 'get') return args.includes('json') ? readyPod : running;
      if (args.includes(GROUPED_EXEC)) {
        await (options as { onStop: (why: string) => Promise<void> }).onStop('cancelled');
        return { stdout: 'partial', stderr: '', exitCode: 143, stopped: 'cancelled' as const };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'npm run e2e', cwd: 'app', signal: stop.signal });

    expect(result).toEqual({ stdout: 'partial', stderr: '', exitCode: 143, stopped: 'cancelled' });
    const grouped = calls.find((call) => call.args.includes(GROUPED_EXEC))!;
    const id = grouped.args.at(-2)!;
    expect(grouped.args.at(-1)).toBe("cd 'app' && npm run e2e");
    expect(grouped.options).toMatchObject({ signal: stop.signal });
    expect(grouped.timeoutMs).toBeUndefined();
    expect(calls.find((call) => call.args.includes(STOP_GROUPED_EXEC))!.args).toEqual(['exec', 'workspace', '-n', NAMESPACE, '--', 'sh', '-c', STOP_GROUPED_EXEC, 'sh', id]);
  });

  it('runs every call in its own process group, so a limit the call set reaches what it started too', async () => {
    const { run, calls } = kube({ get: running });
    await createClusterBackend({ run, workspace }).exec({ sandboxId: 'x', command: 'ls', timeoutMs: 5_000 });
    expect(calls.at(-1)?.args).toEqual(['exec', 'workspace', '-n', NAMESPACE, '-i', '--', 'sh', '-c', GROUPED_EXEC, 'sh', expect.any(String), 'ls']);
  });

  it('really stops what a command started when the stop script runs, and leaves the exit code of one that ends on its own', async () => {
    const run = promisify(execFile);
    const id = `test-${Date.now()}`;
    const marker = `koala-grandchild-${Date.now()}`;
    const started = run('sh', ['-c', GROUPED_EXEC, 'sh', id, `sh -c 'sleep 30; echo ${marker}' & sleep 30`]).catch((err: { code?: number }) => err);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await run('sh', ['-c', STOP_GROUPED_EXEC, 'sh', id]);
    await started;
    const { stdout } = await run('ps', ['-eo', 'args']);
    expect(stdout).not.toContain(`echo ${marker}`);

    const ended = await run('sh', ['-c', GROUPED_EXEC, 'sh', `${id}-b`, 'echo fine; exit 3']).catch((err: { code?: number; stdout?: string }) => err) as { code?: number; stdout?: string };
    expect(ended).toMatchObject({ code: 3, stdout: 'fine\n' });
  });
});
