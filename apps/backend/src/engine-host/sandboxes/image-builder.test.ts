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
