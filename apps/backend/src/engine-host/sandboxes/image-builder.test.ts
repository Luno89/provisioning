import { matching } from '../../platform/lib/test-matchers.js';
import { countsIn, lastComplaint } from './image-builder.js';
import { describe, it, expect, vi } from 'vitest';
import { createImageBuilder, ImageBuildError } from './image-builder.js';
import { imageReference, planImage, type ToolDefinition } from '@koala/agent-engine';
import type { KubeResult, KubeRunner } from './kube.js';
import { reopening } from '@koala/engine-core/reopening';

const REGISTRY = '10.0.0.1:31737';
const HOSTS = { pull: REGISTRY, push: REGISTRY };

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

const revokesNothing = async (_name: string): Promise<void> => undefined;

const PLAIN = planImage({ tools: [] });
const CUSTOM = planImage({ tools: [needsPsql] });

function kube(script: Partial<Record<string, KubeResult>> = {}) {
  const calls: { args: string[]; input?: string | undefined }[] = [];

  const run = vi.fn<KubeRunner>(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    return script[args[0] ?? ''] ?? { stdout: '', stderr: '', exitCode: 0 };
  });

  return { run, calls };
}

const builder = (over: Partial<Parameters<typeof createImageBuilder>[0]> = {}) => {
  const { run, calls } = kube(over.run ? {} : {});
  return {
    calls,
    builder: createImageBuilder({ revokePushToken: revokesNothing,
      run,
      registry: HOSTS,
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
    const build = createImageBuilder({ revokePushToken: revokesNothing, run, registry: HOSTS, published: async () => true });

    expect(await build.ensure(CUSTOM)).toBe(imageReference(REGISTRY, CUSTOM));
    expect(calls.some((call) => call.args[0] === 'apply')).toBe(false);
  });
});

describe('building what does', () => {
  /** The registry starts empty and serves the image once the build has been applied. */
  const servedAfterApply = (calls: { args: string[] }[]) => async () => calls.some((call) => call.args[0] === 'apply');

  it('applies a kaniko job that pushes to the fingerprinted tag', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ revokePushToken: revokesNothing, run, registry: HOSTS, pollMs: 1, published: servedAfterApply(calls) });

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
      const build = createImageBuilder({ revokePushToken: revokesNothing,
        run, registry: { pull: '127.0.0.1:35010', push: 'gitea-http.gitea.svc.cluster.local:3000' }, pollMs: 1,
        pushToken: async () => ({ username: 'bot', password: 'token' }),
      });
      const reference = await build.ensure(CUSTOM);

      expect(reference).toBe(imageReference('127.0.0.1:35010', CUSTOM));
      const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
      expect(applied).toContain(`--destination=${imageReference('gitea-http.gitea.svc.cluster.local:3000', CUSTOM)}`);
      expect(applied).toContain('--registry-map=127.0.0.1:35010=gitea-http.gitea.svc.cluster.local:3000');
      const secret = JSON.parse(applied.split('\n---\n')[0]!) as { stringData: Record<string, string> };
      const config = JSON.parse(secret.stringData['.dockerconfigjson'] ?? '{}') as { auths: Record<string, unknown> };
      expect(Object.keys(config.auths).sort()).toEqual(['127.0.0.1:35010', 'gitea-http.gitea.svc.cluster.local:3000']);
      expect(asked.every((url) => url.startsWith('http://gitea-http.gitea.svc.cluster.local:3000/v2/'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a build verifies TLS for every registry but the instance\'s own', async () => {
    const { run, calls } = kube();
    await createImageBuilder({ run, registry: HOSTS, pollMs: 1, published: servedAfterApply(calls), revokePushToken: async () => undefined }).ensure(CUSTOM);
    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    const args = (JSON.parse(applied.split('\n---\n').at(-1)!) as { spec: { template: { spec: { containers: { args: string[] }[] } } } }).spec.template.spec.containers[0]!.args;
    expect(args.filter((arg) => ['--insecure', '--insecure-pull', '--skip-tls-verify'].includes(arg))).toEqual([]);
    expect(args).toContain(`--insecure-registry=${HOSTS.push}`);
    expect(args).toContain(`--skip-tls-verify-registry=${HOSTS.push}`);
  });

  it('ships the Dockerfile with the job rather than needing a checkout', async () => {
    const { run, calls } = kube();
    await createImageBuilder({ revokePushToken: revokesNothing, run, registry: HOSTS, pollMs: 1, published: servedAfterApply(calls) }).ensure(CUSTOM);

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

    const build = createImageBuilder({ revokePushToken: revokesNothing, run, registry: HOSTS, published: async () => false, pollMs: 1 });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(ImageBuildError);
    await expect(build.ensure(CUSTOM)).rejects.toThrow(/no such package/);
  });

  it('says a build failed as soon as it fails', async () => {
    const { run } = kube({
      get: { stdout: '||1', stderr: '', exitCode: 0 },
      logs: { stdout: 'No match for argument: ripgrep', stderr: '', exitCode: 0 },
    });

    const build = createImageBuilder({ revokePushToken: revokesNothing, run, registry: HOSTS, published: async () => false, pollMs: 1 });

    const started = Date.now();
    await expect(build.ensure(CUSTOM)).rejects.toThrow(/did not build: No match for argument: ripgrep/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps waiting on a build that is still going, however long it takes, and finishes when it is published', async () => {
    let polls = 0;
    const { run } = kube({ get: { stdout: '1||', stderr: '', exitCode: 0 } });
    const build = createImageBuilder({ revokePushToken: revokesNothing,
      run, registry: HOSTS, pollMs: 1, published: async () => { polls += 1; return polls > 30; },
    });

    await expect(build.ensure(CUSTOM)).resolves.toContain(REGISTRY);
    expect(polls).toBeGreaterThan(30);
  });

  it('fails a build whose pod can never start, with the reason, rather than waiting on it', async () => {
    const { run } = kube({ get: { stdout: '1||', stderr: '', exitCode: 0 } });
    const stuck = vi.fn(async (args: string[]) => (args[0] === 'get' && args[1] === 'pods'
      ? { stdout: JSON.stringify({ items: [{ metadata: { name: 'build-x' }, status: { phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } }] } }] }), stderr: '', exitCode: 0 }
      : run(args)));
    const build = createImageBuilder({ revokePushToken: revokesNothing, run: stuck as never, registry: HOSTS, published: async () => false, pollMs: 1 });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(/did not build: build-x: ImagePullBackOff/);
  });

  it('says so when the job cannot even be created', async () => {
    const { run } = kube({ apply: { stdout: '', stderr: 'forbidden', exitCode: 1 } });
    const build = createImageBuilder({ revokePushToken: revokesNothing, run, registry: HOSTS, published: async () => false, pollMs: 1 });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(/Could not start the image build: forbidden/);
  });

  it('names the job after the fingerprint, so two runs wanting the same image share one build', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ revokePushToken: revokesNothing, run, registry: HOSTS, pollMs: 1, published: servedAfterApply(calls) });

    await build.ensure(CUSTOM);

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain(`ws-build-${CUSTOM.fingerprint.slice(0, 16)}`);
  });
});

describe('where images are pushed', () => {
  it('refuses to build with the reason it was given where there is no registry, running nothing', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ revokePushToken: revokesNothing, run, registry: { none: 'root builds no workspace images, so it pushes to no registry' }, published: async () => false, pollMs: 1 });
    await expect(build.ensure(CUSTOM)).rejects.toThrow('root builds no workspace images, so it pushes to no registry');
    expect(calls).toHaveLength(0);
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
    const run = vi.fn<KubeRunner>(async (args, input) => {
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
    const build = createImageBuilder({ run, registry: HOSTS, published: async () => published, pushToken: minting.pushToken, revokePushToken: minting.revokePushToken });

    await build.start(CUSTOM);
    const [secret] = [...secrets.values()];
    expect(secret?.annotations).toEqual({ 'koala.dev/push-token': 'build-1' });
    expect((await build.standing(CUSTOM)).state).toBe('building');
    expect(minting.revoked).toEqual([]);

    jobs.set([...jobs.keys()][0]!, '|1|');
    published = true;
    const elsewhere = createImageBuilder({ run, registry: HOSTS, published: async () => published, pushToken: minting.pushToken, revokePushToken: minting.revokePushToken });
    expect((await elsewhere.standing(CUSTOM)).state).toBe('ready');
    expect(minting.revoked).toEqual(['build-1']);
    expect(secrets.size).toBe(0);
  });

  it('says so when the builds\' secrets cannot be listed, rather than taking it as no token to revoke', async () => {
    const { run } = cluster();
    const listing = vi.fn<KubeRunner>(async (args, input) => (args[0] === 'get' && args[1] === 'secrets'
      ? { stdout: '', stderr: 'Error from server (Forbidden): secrets is forbidden', exitCode: 1 }
      : run(args, input)));
    const minting = tokens();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const build = createImageBuilder({ run: listing, registry: HOSTS, published: async () => false, pushToken: minting.pushToken, revokePushToken: minting.revokePushToken });
      await build.start(CUSTOM);
      expect(warn).toHaveBeenCalledWith(matching(/push tokens of finished builds stay valid.*secrets is forbidden/));
    } finally {
      warn.mockRestore();
    }
  });

  it('is revoked for a failed build, and for one whose job is gone, before the next build mints its own', async () => {
    const { run, secrets, jobs } = cluster();
    const minting = tokens();
    const build = createImageBuilder({ run, registry: HOSTS, published: async () => false, pushToken: minting.pushToken, revokePushToken: minting.revokePushToken });

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

describe('whether an image is published, asked of the registry', () => {
  it('is published on 200 and not on 404, and anything else is a failure with what the registry answered', async () => {
    const answers = new Map([[200, true], [404, false]]);
    let status = 200;
    const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status }));
    try {
      const build = createImageBuilder({ revokePushToken: revokesNothing, run: kube().run, registry: HOSTS });
      for (const [given, published] of answers) {
        status = given;
        expect(await build.exists(PLAIN)).toBe(published);
      }
      for (const given of [401, 500]) {
        status = given;
        await expect(build.exists(PLAIN)).rejects.toMatchObject({ status: given, message: matching(new RegExp(`^the image registry answered ${given} when asked whether .+ is published$`)) });
      }
      expect(fetched.mock.calls[0]![0]).toMatch(/^http:\/\/10\.0\.0\.1:31737\/v2\/.+\/manifests\//);
    } finally {
      fetched.mockRestore();
    }
  });
});

describe('an image registry that cannot say whether an image is built', () => {
  it('is asked again until it answers, never taken as having no image, and a refusal stops the build with why', async () => {
    let asked = 0;
    const flaky = createImageBuilder({ revokePushToken: revokesNothing,
      run: kube().run, registry: HOSTS, askAgain: () => reopening(1),
      published: async () => { asked += 1; if (asked < 3) throw Object.assign(new Error('the image registry answered 503'), { status: 503 }); return true; },
    });
    expect(await flaky.ensure(CUSTOM)).toBe(imageReference(REGISTRY, CUSTOM));
    expect(asked).toBe(3);

    const refusing = createImageBuilder({ revokePushToken: revokesNothing, run: kube().run, registry: HOSTS, published: async () => { throw Object.assign(new Error('the image registry answered 401'), { status: 401 }); } });
    await expect(refusing.ensure(CUSTOM)).rejects.toThrow(`The image registry could not be asked whether ${CUSTOM.fingerprint} is built: the image registry answered 401`);
  });
});
