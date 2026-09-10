import { describe, it, expect } from 'vitest';
import { approvalModeFor, buildLocalSandboxSpec } from './local-execution-target.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';

describe('approvalModeFor', () => {
  it('defaults to plan mode when nothing is set', () => {
    expect(approvalModeFor(undefined)).toBe('plan');
    expect(approvalModeFor({})).toBe('plan');
  });

  it('defaults to plan mode for any value other than an explicit "auto"', () => {
    expect(approvalModeFor({ executionApproval: 'plan' })).toBe('plan');
  });

  it('only switches to auto when explicitly set', () => {
    expect(approvalModeFor({ executionApproval: 'auto' })).toBe('auto');
  });
});

describe('buildLocalSandboxSpec', () => {
  it('resolves an image for the given language, never a tree-type/binding egress rule', () => {
    const spec = buildLocalSandboxSpec({ leafId: 'leaf-1', ownerId: 'u1' }, IMAGES, 'node');
    expect(spec).toEqual({ leafId: 'leaf-1', ownerId: 'u1', image: expect.any(String) });
    expect(spec.egress).toBeUndefined();
  });

  it('falls back to the default image when no language is given', () => {
    const spec = buildLocalSandboxSpec({ leafId: 'leaf-1', ownerId: 'u1' }, IMAGES, undefined);
    expect(spec.image).toBeTruthy();
  });
});
