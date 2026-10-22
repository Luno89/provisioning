import { describe, it, expect } from 'vitest';
import { planHostMemory, parseQuantity } from './host-memory-plan.js';

const measured = {
  modelBytes: 19e9,
  gpuCount: 2,
  maxSeqLen: 262144,
  allocatableBytes: 30 * 1024 ** 3,
};

describe('planHostMemory', () => {
  it('lands near what the deployment actually charges, at the sequence length in force', () => {
    const plan = planHostMemory({ ...measured, maxSeqLen: 32768, inlineModelLoading: false });
    const gib = plan.limitBytes / 1024 ** 3;

    expect(gib).toBeGreaterThan(13);
    expect(gib).toBeLessThan(20);
    expect(plan.refusal).toBeUndefined();
  });

  it('refuses the 256K configuration that actually OOMKilled the pod', () => {
    const plan = planHostMemory({ ...measured, inlineModelLoading: false });
    expect(plan.refusal).toMatch(/needs about/);
  });

  it('charges for inline loading, which is what the 21 GiB was', () => {
    const off = planHostMemory({ ...measured, inlineModelLoading: false });
    const on = planHostMemory({ ...measured, inlineModelLoading: true });

    expect(on.limitBytes).toBeGreaterThan(off.limitBytes);
    expect((on.limitBytes - off.limitBytes) / 1e9).toBeGreaterThan(10);
  });

  it('refuses a deployment the node cannot hold, and says what to change', () => {
    const plan = planHostMemory({ ...measured, inlineModelLoading: true });

    expect(plan.refusal).toMatch(/needs about/);
    expect(plan.refusal).toMatch(/inline model loading/i);
    expect(plan.refusal).toMatch(/allocatable/);
  });

  it('leaves the node room for everything that is not this pod', () => {
    const plan = planHostMemory({ ...measured, inlineModelLoading: false });
    expect(plan.budgetBytes).toBeLessThan(measured.allocatableBytes);
  });

  it('still plans when the node cannot be measured, but claims no budget', () => {
    const plan = planHostMemory({ ...measured, inlineModelLoading: false, allocatableBytes: undefined });

    expect(plan.limitBytes).toBeGreaterThan(0);
    expect(plan.budgetBytes).toBeUndefined();
    expect(plan.refusal).toBeUndefined();
  });

  it('assumes a large model when the size lookup failed, and says so', () => {
    const plan = planHostMemory({
      ...measured, modelBytes: undefined, inlineModelLoading: true, allocatableBytes: 128 * 1024 ** 3,
    });

    expect(plan.basis).toMatch(/size lookup failed/);
    expect(plan.limitBytes).toBeGreaterThan(10e9);
  });

  it('sizes shared memory per shard, since tensor parallelism splits the weights', () => {
    const one = planHostMemory({ ...measured, gpuCount: 1, inlineModelLoading: false });
    const two = planHostMemory({ ...measured, gpuCount: 2, inlineModelLoading: false });

    expect(two.shmBytes).toBeLessThan(one.shmBytes);
    expect(two.shmBytes).toBeGreaterThan(4e9);
  });

  it('scales with the context window', () => {
    const short = planHostMemory({ ...measured, maxSeqLen: 32768, inlineModelLoading: false });
    const long = planHostMemory({ ...measured, maxSeqLen: 262144, inlineModelLoading: false });

    expect(long.limitBytes).toBeGreaterThan(short.limitBytes);
  });
});

describe('parseQuantity', () => {
  it('reads what a node actually reports', () => {
    expect(parseQuantity('32800000Ki')).toBe(32800000 * 1024);
    expect(parseQuantity('30Gi')).toBe(30 * 1024 ** 3);
    expect(parseQuantity('8G')).toBe(8e9);
    expect(parseQuantity('1024')).toBe(1024);
  });

  it('returns undefined for something it does not understand, rather than zero', () => {
    expect(parseQuantity('lots')).toBeUndefined();
    expect(parseQuantity('')).toBeUndefined();
  });
});

describe('shared memory is inside the limit, not beside it', () => {
  it('includes /dev/shm in the container limit', () => {
    const plan = planHostMemory({ ...measured, inlineModelLoading: false });
    expect(plan.limitBytes).toBeGreaterThan(plan.shmBytes);
    expect(plan.limitBytes - plan.shmBytes).toBeGreaterThan(5e9);
  });

  it('refuses when the weights plus their staging cannot fit the node', () => {
    const plan = planHostMemory({
      modelBytes: 90e9, gpuCount: 1, maxSeqLen: 32768,
      inlineModelLoading: false, allocatableBytes: 30 * 1024 ** 3,
    });
    expect(plan.refusal).toMatch(/needs about/);
  });
});

describe('a chosen limit beats a computed one', () => {
  const pick = (chosen: string | undefined, planned: number) => chosen || `${Math.ceil(planned / 1e9)}G`;

  it('uses what was typed when something was typed', () => {
    const plan = planHostMemory({ ...measured, maxSeqLen: 32768, inlineModelLoading: false });
    expect(pick('12G', plan.limitBytes)).toBe('12G');
  });

  it('falls back to the plan when nothing was', () => {
    const plan = planHostMemory({ ...measured, maxSeqLen: 32768, inlineModelLoading: false });
    expect(pick(undefined, plan.limitBytes)).toBe(`${Math.ceil(plan.limitBytes / 1e9)}G`);
  });

  it('can tell that a chosen limit is under the estimate, so it can be said out loud', () => {
    const plan = planHostMemory({ ...measured, maxSeqLen: 32768, inlineModelLoading: false });
    expect(parseQuantity('12G')!).toBeLessThan(plan.limitBytes);
  });
});

describe('a size lookup that fails quietly', () => {
  it('treats zero bytes as unknown, not as a very small model', () => {
    const zero = planHostMemory({ ...measured, modelBytes: 0, maxSeqLen: 32768, inlineModelLoading: false });
    const missing = planHostMemory({ ...measured, modelBytes: undefined, maxSeqLen: 32768, inlineModelLoading: false });

    expect(zero.limitBytes).toBe(missing.limitBytes);
    expect(zero.basis).toMatch(/size lookup failed/);
  });
});
