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
  status: 'approved',
  approvedBy: 'luno',
  returns: 'rows',
  failures: [{ when: 'the query is bad', says: 'the query failed' }],
  parameters: { type: 'object', properties: { sql: { type: 'string', description: 'the query' } } },
  needsBinaries: ['psql'],
  install: { via: 'dnf', packages: ['postgresql'] },
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
  it('applies a kaniko job that pushes to the fingerprinted tag', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false });

    const reference = await build.ensure(CUSTOM);

    expect(reference).toBe(imageReference(REGISTRY, CUSTOM));

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('kaniko-project/executor');
    expect(applied).toContain(`--destination=${reference}`);
    expect(applied).toContain('pipeline-build-sa');
  });

  it('ships the Dockerfile with the job rather than needing a checkout', async () => {
    const { run, calls } = kube();
    await createImageBuilder({ run, registry: REGISTRY, published: async () => false }).ensure(CUSTOM);

    const applied = calls.find((call) => call.args[0] === 'apply')?.input ?? '';
    expect(applied).toContain('ConfigMap');
    expect(applied).toContain('microdnf install -y postgresql');
    expect(applied).toContain('dnf install -y postgresql');
    expect(applied).toContain('--context=dir:///workspace');
  });

  it('waits for the job and reports the build log when it fails', async () => {
    const { run } = kube({
      wait: { stdout: '', stderr: 'timed out', exitCode: 1 },
      logs: { stdout: 'error building image: no such package', stderr: '', exitCode: 0 },
    });

    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(ImageBuildError);
    await expect(build.ensure(CUSTOM)).rejects.toThrow(/no such package/);
  });

  it('says so when the job cannot even be created', async () => {
    const { run } = kube({ apply: { stdout: '', stderr: 'forbidden', exitCode: 1 } });
    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false });

    await expect(build.ensure(CUSTOM)).rejects.toThrow(/Could not start the image build: forbidden/);
  });

  it('names the job after the fingerprint, so two runs wanting the same image share one build', async () => {
    const { run, calls } = kube();
    const build = createImageBuilder({ run, registry: REGISTRY, published: async () => false });

    await build.ensure(CUSTOM);
    const first = calls.find((call) => call.args[0] === 'wait')?.args.join(' ') ?? '';

    expect(first).toContain(CUSTOM.fingerprint.slice(0, 16));
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
    const run: KubeRunner = vi.fn(async (args) => {
      if (args[0] === 'get') {
        lookups += 1;
        return args[1] === 'svc'
          ? { stdout: '31737', stderr: '', exitCode: 0 }
          : { stdout: '10.0.0.130', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const build = createImageBuilder({ run, published: async () => false });
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
  });

  it('has nothing to say about empty logs', () => {
    expect(lastComplaint('   ')).toBeUndefined();
  });
});
