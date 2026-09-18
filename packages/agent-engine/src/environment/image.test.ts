import { describe, it, expect } from 'vitest';
import {
  BASES, DEFAULT_BASE, UnbuildableError,
  fingerprint, imageFor, imageReference, needsBuilding, planImage, renderDockerfile,
} from './image.js';
import type { ToolDefinition } from '../tools/catalogue.js';

const tool = (over: Partial<ToolDefinition> & Pick<ToolDefinition, 'name'>): ToolDefinition => ({
  summary: 'does a thing',
  binding: 'environment',
  effect: 'write',
  status: 'approved',
  approvedBy: 'luno',
  returns: 'output',
  failures: [{ when: 'it breaks', says: 'it broke' }],
  parameters: { type: 'object', properties: { x: { type: 'string', description: 'x' } } },
  ...over,
});

const REGISTRY = '10.0.0.1:31737';

describe('planning what has to be in the image', () => {
  it('needs no build when every tool is served by the base', () => {
    const plan = planImage({ tools: [tool({ name: 'run_tests', needsBinaries: ['node', 'npm'] })] });

    expect(plan.installs).toEqual([]);
    expect(needsBuilding(plan)).toBe(false);
    expect(imageFor(REGISTRY, plan)).toBe(plan.base);
  });

  it('collects the installs for what the base does not have', () => {
    const plan = planImage({
      tools: [tool({
        name: 'query_db',
        needsBinaries: ['psql'],
        install: { via: 'dnf', packages: ['postgresql'] },
      })],
    });

    expect(plan.installs).toEqual([{ via: 'dnf', packages: ['postgresql'] }]);
    expect(plan.provides).toContain('psql');
    expect(needsBuilding(plan)).toBe(true);
  });

  it('ignores tools that never run in the workspace', () => {
    const plan = planImage({
      tools: [tool({ name: 'search_web', binding: 'network', needsBinaries: undefined })],
    });

    expect(plan.installs).toEqual([]);
  });

  it('refuses to plan an image for a tool that cannot be installed', () => {
    expect(() => planImage({ tools: [tool({ name: 'query_db', needsBinaries: ['psql'] })] }))
      .toThrow(UnbuildableError);
  });

  it('names the tool and the binary when it refuses, so the fix is obvious', () => {
    try {
      planImage({ tools: [tool({ name: 'query_db', needsBinaries: ['psql'] })] });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('query_db needs psql');
      expect((err as Error).message).toContain('does not say how to install it');
    }
  });

  it('refuses a base nobody has heard of', () => {
    expect(() => planImage({ base: 'cobol', tools: [] })).toThrow(/no base image called "cobol"/);
  });

  it('starts from the base a tool set actually asks for', () => {
    const plan = planImage({ base: 'python', tools: [] });

    expect(plan.base).toBe(BASES.find((b) => b.id === 'python')!.image);
    expect(plan.provides).toContain('pip');
  });
});

describe('fingerprinting, so identical tool sets share one image', () => {
  const psql = tool({ name: 'a', needsBinaries: ['psql'], install: { via: 'dnf', packages: ['postgresql'] } });
  const jq = tool({ name: 'b', needsBinaries: ['jq'], install: { via: 'dnf', packages: ['jq'] } });

  it('is the same for the same installs in a different order', () => {
    expect(planImage({ tools: [psql, jq] }).fingerprint)
      .toBe(planImage({ tools: [jq, psql] }).fingerprint);
  });

  it('is the same for the same packages listed in a different order', () => {
    expect(fingerprint('base', [{ via: 'dnf', packages: ['a', 'b'] }]))
      .toBe(fingerprint('base', [{ via: 'dnf', packages: ['b', 'a'] }]));
  });

  it('changes when an install changes', () => {
    expect(planImage({ tools: [psql] }).fingerprint).not.toBe(planImage({ tools: [psql, jq] }).fingerprint);
  });

  it('changes when the base changes, since the same installs on a different base are a different image', () => {
    expect(planImage({ base: 'node', tools: [psql] }).fingerprint)
      .not.toBe(planImage({ base: 'python', tools: [psql] }).fingerprint);
  });

  it('is the tag, so the registry can be asked whether it already exists', () => {
    const plan = planImage({ tools: [psql] });
    expect(imageReference(REGISTRY, plan)).toBe(`${REGISTRY}/koala/workspace:${plan.fingerprint}`);
  });
});

describe('the Dockerfile it produces', () => {
  it('installs each package manager exactly once, and drops back to a non-root user', () => {
    const plan = planImage({
      tools: [
        tool({ name: 'a', needsBinaries: ['psql'], install: { via: 'dnf', packages: ['postgresql'] } }),
        tool({ name: 'b', needsBinaries: ['ruff'], install: { via: 'pip', packages: ['ruff'] } }),
      ],
    });

    const dockerfile = renderDockerfile(plan);

    expect(dockerfile).toContain(`FROM ${plan.base}`);
    expect(dockerfile).toContain('microdnf install -y postgresql');
    expect(dockerfile).toContain('pip install --no-cache-dir ruff');
    expect(dockerfile.trimEnd().endsWith('USER 1000')).toBe(true);
  });

  it('cleans up after itself so the image does not carry package caches', () => {
    const plan = planImage({
      tools: [tool({ name: 'a', needsBinaries: ['jq'], install: { via: 'dnf', packages: ['jq'] } })],
    });

    expect(renderDockerfile(plan)).toContain('microdnf clean all');
  });

  it('runs a script install as written', () => {
    const plan = planImage({
      tools: [tool({
        name: 'a',
        needsBinaries: ['rg'],
        install: { via: 'script', run: 'curl -L example.invalid/rg | tar xz -C /usr/local/bin' },
      })],
    });

    expect(renderDockerfile(plan)).toContain('RUN curl -L example.invalid/rg');
  });

  it('is just the base when nothing needs installing', () => {
    expect(renderDockerfile(planImage({ tools: [] })).split('\n').filter(Boolean))
      .toEqual([`FROM ${BASES.find((b) => b.id === DEFAULT_BASE)!.image}`, 'USER root', 'USER 1000']);
  });
});
