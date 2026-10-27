import { countsIn, lastComplaint, pickAddress } from './image-builder.js';
import { describe, it, expect, vi } from 'vitest';
import { createImageBuilder, discoverRegistry, ImageBuildError } from './image-builder.js';
import { imageReference, planImage, type ToolDefinition } from '@koala/agent-engine';
import type { KubeResult, KubeRunner } from './kube.js';

const REGISTRY = '10.0.0.1:31737';

const needsPsql: ToolDefinition = {
  name: 'query_db',
  summary: 'Query a database',
  binding: 'environment',
  effect: 'read',
  idempotent: false,
  openWorld: false,
  returns: 'rows',
  failures: [{ when: 'the query is bad', says: 'the query failed' }],
  parameters: { type: 'object', properties: { sql: { type: 'string', description: 'the query' } } },
  needs: ['go'],
};

const PLAIN = planImage({ tools: [] });
const CUSTOM = planImage({ tools: [needsPsql] });

function kube(script: Partial<Record<string, KubeResult>> = {}) {
  const calls: { args: string[]; input?: string | undefined }[] = [];

  const run: KubeRunner = vi.fn(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    return script[args[0] ?? ''] ?? { stdout: '', stderr: '', exitCode: 0 };
  });

  return { run, calls };
}

const builder = (over: Partial<Parameters<typeof createImageBuilder>[0]> = {}) => {
  const { run, calls } = kube(over.run ? {} : {});
  return {
    calls,
    builder: createImageBuilder({
      run,
      registry: REGISTRY,
      published: async () => false,
      ...over,
    }),
  };
};

describe('not building what does not need building', () => {
  it('uses the base image directly when no tool needs installing', async () => {
    const { builder: build, calls } = builder();

    expect(await build.ensure(PLAIN)).toBe(PLAIN.base);
    expect(calls).toHaveLength(0);
  });

  it('skips the build when the registry already has that fingerprint', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => true });

    expect(await build.ensure(CUSTOM)).toBe(imageReference(REGISTRY, CUSTOM));
    expect(calls.some((call) => call.args[0] === 'apply')).toBe(false);
  });
});

describe('building what does', () => {
  /** The registry starts empty and serves the image once the build has been applied. */
  const servedAfterApply = (calls: { args: string[] }[]) => async () => calls.some((call) => call.args[0] === 'apply');

  it('applies a kaniko job that pushes to the fingerprinted tag', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ run, registry: REGISTRY, pollMs: 1, published: servedAfterApply(calls) });

    const reference = await build.ensure(CUSTOM);

    expect(reference).toBe(imageReference(REGISTRY, CUSTOM));

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('kaniko-project/executor:v1.24.0');
    expect(applied).not.toContain('executor:latest');
    expect(applied).toContain(`--destination=${reference}`);
    expect(applied).toContain('pipeline-build-sa');
    expect(applied).toContain('--compressed-caching=false');
    expect(applied).toContain('--snapshot-mode=redo');
    expect(applied).toContain('"requests":{"cpu":"250m","memory":"1Gi"},"limits":{"cpu":"2","memory":"10Gi"}');
  });

  it('in a pool instance, names the image for the node to pull, but pushes, signs in and checks where the builds reach', async () => {
    const { run, calls } = kube();
    const asked: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      asked.push(String(url));
      return new Response(null, { status: calls.some((call) => call.args[0] === 'apply') ? 200 : 404 });
    });
    try {
      const build = createImageBuilder({
        run, registry: '127.0.0.1:35010', pushRegistry: 'gitea-http.gitea.svc.cluster.local:3000', pollMs: 1,
        pushToken: async () => ({ username: 'bot', password: 'token' }),
      });
      const reference = await build.ensure(CUSTOM);

      expect(reference).toBe(imageReference('127.0.0.1:35010', CUSTOM));
      const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
      expect(applied).toContain(`--destination=${imageReference('gitea-http.gitea.svc.cluster.local:3000', CUSTOM)}`);
      expect(applied).toContain('--registry-map=127.0.0.1:35010=gitea-http.gitea.svc.cluster.local:3000');
      const config = JSON.parse(JSON.parse(applied.split('\n---\n')[0]!).stringData['.dockerconfigjson']);
      expect(Object.keys(config.auths).sort()).toEqual(['127.0.0.1:35010', 'gitea-http.gitea.svc.cluster.local:3000']);
      expect(asked.every((url) => url.startsWith('http://gitea-http.gitea.svc.cluster.local:3000/v2/'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('ships the Dockerfile with the job rather than needing a checkout', async () => {
    const { run, calls } = kube();
    await createImageBuilder({ run, registry: REGISTRY, pollMs: 1, published: servedAfterApply(calls) }).ensure(CUSTOM);

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('ConfigMap');
    expect(applied).toContain("microdnf install -y 'go-toolset'");
    expect(applied).toContain("dnf install -y 'go-toolset'");
    expect(applied).toContain('--context=dir:///workspace');
  });

  it('reports the build log when the job fails', async () => {
    const { run } = kube({
      get: { stdout: '||1', stderr: '', exitCode: 0 },
      logs: { stdout: 'error building image: no such package', stderr: '', exitCode: 0 },
    });

    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false, pollMs: 1 });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(ImageBuildError);
    await expect(build.ensure(CUSTOM)).rejects.toThrow(/no such package/);
  });

  it('says a build failed as soon as it fails', async () => {
    const { run } = kube({
      get: { stdout: '||1', stderr: '', exitCode: 0 },
      logs: { stdout: 'No match for argument: ripgrep', stderr: '', exitCode: 0 },
    });

    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false, pollMs: 1 });

    const started = Date.now();
    await expect(build.ensure(CUSTOM)).rejects.toThrow(/did not build: No match for argument: ripgrep/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps waiting on a build that is still going, however long it takes, and finishes when it is published', async () => {
    let polls = 0;
    const { run } = kube({ get: { stdout: '1||', stderr: '', exitCode: 0 } });
    const build = createImageBuilder({
      run, registry: REGISTRY, pollMs: 1, published: async () => { polls += 1; return polls > 30; },
    });

    await expect(build.ensure(CUSTOM)).resolves.toContain(REGISTRY);
    expect(polls).toBeGreaterThan(30);
  });

  it('fails a build whose pod can never start, with the reason, rather than waiting on it', async () => {
    const { run } = kube({ get: { stdout: '1||', stderr: '', exitCode: 0 } });
    const stuck = vi.fn(async (args: string[]) => (args[0] === 'get' && args[1] === 'pods'
      ? { stdout: JSON.stringify({ items: [{ metadata: { name: 'build-x' }, status: { phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } }] } }] }), stderr: '', exitCode: 0 }
      : run(args)));
    const build = createImageBuilder({ run: stuck as never, registry: REGISTRY, published: async () => false, pollMs: 1 });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(/did not build: build-x: ImagePullBackOff/);
  });

  it('says so when the job cannot even be created', async () => {
    const { run } = kube({ apply: { stdout: '', stderr: 'forbidden', exitCode: 1 } });
    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false, pollMs: 1 });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(/Could not start the image build: forbidden/);
  });

  it('names the job after the fingerprint, so two runs wanting the same image share one build', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ run, registry: REGISTRY, pollMs: 1, published: servedAfterApply(calls) });

    await build.ensure(CUSTOM);

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain(`ws-build-${CUSTOM.fingerprint.slice(0, 16)}`);
  });
});

describe('finding the registry rather than being told', () => {
  it('builds the address from the node and the pinned NodePort', async () => {
    const run: KubeRunner = vi.fn(async (args) => {
      if (args[1] === 'svc') return { stdout: '31737', stderr: '', exitCode: 0 };
      return { stdout: '10.0.0.130', stderr: '', exitCode: 0 };
    });

    expect(await discoverRegistry(run)).toBe('10.0.0.130:31737');
  });

  it('says the registry is missing rather than pushing somewhere malformed', async () => {
    const run: KubeRunner = vi.fn(async () => ({ stdout: '', stderr: 'NotFound', exitCode: 1 }));

    await expect(discoverRegistry(run)).rejects.toThrow(/Could not find the image registry/);
  });

  it('says so when the node has no address the registry could be reached at', async () => {
    const run: KubeRunner = vi.fn(async (args) =>
      (args[1] === 'svc'
        ? { stdout: '31737', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 }));

    await expect(discoverRegistry(run)).rejects.toThrow(/node address/);
  });

  it('discovers once and reuses it, rather than asking per build', async () => {
    let lookups = 0;
    let applied = 0;
    const run: KubeRunner = vi.fn(async (args) => {
      if (args[0] === 'apply') {
        applied += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'get' && (args[1] === 'svc' || args[1] === 'nodes')) {
        lookups += 1;
        return args[1] === 'svc'
          ? { stdout: '31737', stderr: '', exitCode: 0 }
          : { stdout: '10.0.0.130', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'get') return { stdout: '|1|', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const build = createImageBuilder({ run, pollMs: 1, published: async () => applied > 0 });
    const reference = await build.ensure(CUSTOM);
    await build.ensure(CUSTOM);

    expect(reference.startsWith('10.0.0.130:31737/')).toBe(true);
    expect(lookups).toBe(2);
  });
});


describe('the address the registry is reached at', () => {
  it('takes the IPv4 one when a node reports both', () => {
    expect(pickAddress('10.0.0.130 2601:600:8f00:4030::6dc7')).toBe('10.0.0.130');
  });

  it('falls back to the only address there is', () => {
    expect(pickAddress('2601:600:8f00:4030::6dc7')).toBe('2601:600:8f00:4030::6dc7');
  });

  it('has nothing to give when the node reported nothing', () => {
    expect(pickAddress('  ')).toBeUndefined();
  });
});


describe('reading what a build job is doing', () => {
  it('reads a job that failed as failed, not as one still running', () => {
    expect(countsIn('||1')).toEqual({ active: 0, succeeded: 0, failed: 1 });
  });

  it('reads a job still running as active', () => {
    expect(countsIn('1||')).toEqual({ active: 1, succeeded: 0, failed: 0 });
  });

  it('reads a finished job as succeeded', () => {
    expect(countsIn('|1|')).toEqual({ active: 0, succeeded: 1, failed: 0 });
  });

  it('reads a job that has reported nothing yet as nothing at all', () => {
    expect(countsIn('||')).toEqual({ active: 0, succeeded: 0, failed: 0 });
  });
});


describe('saying why a build failed', () => {
  it('picks the first line that names the cause, not the wrapper it ends with', () => {
    const logs = [
      '\u001b[36mINFO\u001b[0m[0001] Unpacking rootfs',
      'Red Hat Universal Base Image 9 (RPMs) - AppStream  12 MB/s',
      'No match for argument: ripgrep',
      'Error: Unable to find a match: ripgrep',
      'error building image: error building stage: failed to execute command',
    ].join('\n');

    expect(lastComplaint(logs)).toBe('No match for argument: ripgrep');
  });

  it('falls back to the last thing said when nothing looks like a complaint', () => {
    expect(lastComplaint('INFO[0001] Unpacking rootfs\nsomething happened')).toBe('something happened');
    expect(lastComplaint([
      'the dependency liar said it puts rg in the workspace, and once it was installed rg is not there',
      'the dependency fonts said it puts libfreetype.so.6 in the workspace, and once it was installed libfreetype.so.6 is not there',
      'error building image: error building stage: failed to execute command: waiting for process to exit: exit status 1',
    ].join('\n'))).toBe('the dependency liar said it puts rg in the workspace, and once it was installed rg is not there; the dependency fonts said it puts libfreetype.so.6 in the workspace, and once it was installed libfreetype.so.6 is not there');
  });

  it('has nothing to say about empty logs', () => {
    expect(lastComplaint('   ')).toBeUndefined();
  });
});

describe('the token a workspace build pushes with', () => {
  function cluster() {
    const secrets = new Map<string, { name: string; labels?: Record<string, string>; annotations?: Record<string, string> }>();
    const jobs = new Map<string, string>();
    const run: KubeRunner = vi.fn(async (args, input) => {
      const ok = (stdout = ''): KubeResult => ({ stdout, stderr: '', exitCode: 0 });
      if (args[0] === 'apply') {
        for (const doc of (input ?? '').split('\n---\n').map((text: string) => JSON.parse(text) as { kind: string; metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> } })) {
          if (doc.kind === 'Secret') secrets.set(doc.metadata.name, doc.metadata);
          if (doc.kind === 'Job') jobs.set(doc.metadata.name, '1||');
        }
        return ok();
      }
      if (args[0] === 'get' && args[1] === 'secrets') return ok(JSON.stringify({ items: [...secrets.values()].map((metadata) => ({ metadata })) }));
      if (args[0] === 'get' && args[1] === 'job') {
        const status = jobs.get(args[2]!);
        return status === undefined ? { stdout: '', stderr: `Error from server (NotFound): jobs.batch "${args[2]}" not found`, exitCode: 1 } : ok(status);
      }
      if (args[0] === 'delete' && args[1] === 'secret') { secrets.delete(args[2]!); return ok(); }
      return ok();
    });
    return { run, secrets, jobs };
  }

  const tokens = () => {
    let minted = 0;
    const revoked: string[] = [];
    return {
      revoked,
      pushToken: async () => { minted += 1; return { username: 'koala', password: `secret-${minted}`, name: `build-${minted}` }; },
      revokePushToken: async (name: string) => { revoked.push(name); },
    };
  };

  it('is revoked once the build has finished and its image is there, whichever process sees it, and never while it runs', async () => {
    const { run, secrets, jobs } = cluster();
    const minting = tokens();
    let published = false;
    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => published, pushToken: minting.pushToken, revokePushToken: minting.revokePushToken });

    await build.start(CUSTOM);
    const [secret] = [...secrets.values()];
    expect(secret?.annotations).toEqual({ 'koala.dev/push-token': 'build-1' });
    expect((await build.standing(CUSTOM)).state).toBe('building');
    expect(minting.revoked).toEqual([]);

    jobs.set([...jobs.keys()][0]!, '|1|');
    published = true;
    const elsewhere = createImageBuilder({ run, registry: REGISTRY, published: async () => published, pushToken: minting.pushToken, revokePushToken: minting.revokePushToken });
    expect((await elsewhere.standing(CUSTOM)).state).toBe('ready');
    expect(minting.revoked).toEqual(['build-1']);
    expect(secrets.size).toBe(0);
  });

  it('is revoked for a failed build, and for one whose job is gone, before the next build mints its own', async () => {
    const { run, secrets, jobs } = cluster();
    const minting = tokens();
    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false, pushToken: minting.pushToken, revokePushToken: minting.revokePushToken });

    await build.start(CUSTOM);
    jobs.set([...jobs.keys()][0]!, '||1');
    expect((await build.standing(CUSTOM)).state).toBe('failed');
    expect(minting.revoked).toEqual(['build-1']);

    secrets.set('ws-build-gone-registry', { name: 'ws-build-gone-registry', labels: { 'koala.dev/image': 'gone' }, annotations: { 'koala.dev/push-token': 'build-0' } });
    const other = planImage({ tools: [{ ...needsPsql, name: 'other', needs: ['python'] }] });
    await build.start(other);
    expect(minting.revoked).toEqual(['build-1', 'build-0']);
    expect([...secrets.values()].map((entry) => entry.annotations?.['koala.dev/push-token'])).toEqual(['build-2']);
  });
});
