import { describe, it, expect } from 'vitest';
import { buildManifests, labelValue, workspaceName, type RunWorkspace } from './workspace.js';

const LONG_RUN = 'eval2-6daa66c6-7dab-4acf-bf6d-c54e42840637-executor-reads-what-is-there';

const workspace = (over: Partial<RunWorkspace> = {}): RunWorkspace => ({
  runId: 'run-1',
  ownerId: 'user-1',
  agent: 'executor',
  image: 'registry.access.redhat.com/ubi9/nodejs-22',
  provides: ['bash', 'node'],
  egressMode: 'declared',
  lifetimeMs: 600_000,
  cpu: '2',
  memory: '2Gi',
  env: [],
  egress: [],
  ...over,
});

describe('naming a workspace after a run', () => {
  it('keeps a short run id as it is', () => {
    expect(workspaceName('run-1')).toBe('koala-run-run-1');
  });

  it('fits a long run id into what Kubernetes accepts, and stays stable', () => {
    const name = workspaceName(LONG_RUN);

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(workspaceName(LONG_RUN)).toBe(name);
  });

  it('gives two long run ids that share a prefix different names', () => {
    expect(workspaceName(`${LONG_RUN}-one`)).not.toBe(workspaceName(`${LONG_RUN}-two`));
  });

  it('refuses a run id with nothing to name a workspace after', () => {
    expect(() => workspaceName('///')).toThrow(/Cannot name a workspace/);
  });
});

describe('labelling a workspace', () => {
  it('leaves a value Kubernetes already accepts alone', () => {
    expect(labelValue('executor')).toBe('executor');
  });

  it('cuts a value that is too long down to the limit', () => {
    const value = labelValue(LONG_RUN);

    expect(value.length).toBeLessThanOrEqual(63);
    expect(value).toMatch(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/);
  });

  it('puts only values Kubernetes accepts on the manifests of a long run', () => {
    const manifests = buildManifests(workspace({ runId: LONG_RUN })) as { metadata: { labels: Record<string, string> } }[];

    for (const manifest of manifests) {
      for (const [key, value] of Object.entries(manifest.metadata.labels ?? {})) {
        expect(value.length, `${key} is too long`).toBeLessThanOrEqual(63);
        expect(value, key).toMatch(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/);
      }
    }
  });
});
