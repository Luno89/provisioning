/**
 * The case these exist for was measured, not imagined: a TabbyAPI deployment took 21.4 GiB of host
 * RAM on a 30 GiB workstation, leaving 244 MiB free and 8.6 GiB swapped, while its own memory limit
 * was 32G — a limit above the machine's physical memory, which can never bind.
 */
import { describe, it, expect } from 'vitest';
import { planHostMemory, parseQuantity } from './host-memory-plan.js';

/** The live deployment: 19 GB of exl3 weights across two RTX 3090s at 256K context. */
const measured = {
  modelBytes: 19e9,
  gpuCount: 2,
  maxSeqLen: 262144,
  allocatableBytes: 30 * 1024 ** 3,
};

describe('planHostMemory', () => {
  it('lands near what the deployment actually charges, at the sequence length in force', () => {
    /**
     * Two lines, not one. `free` reported 7.8 GiB resident for the process and 5 GiB of SHARED
     * memory separately — and the cgroup is charged for both, which is what the limit has to cover.
     * So the calibration target is roughly 13 GiB of real charge, not the 7.8 GiB RSS alone.
     *
     * Measured at 32K, the configuration actually running. The 256K variant is checked below,
     * where it is correctly refused rather than deployed and OOMKilled.
     */
    const plan = planHostMemory({ ...measured, maxSeqLen: 32768, inlineModelLoading: false });
    const gib = plan.limitBytes / 1024 ** 3;

    expect(gib).toBeGreaterThan(13);
    expect(gib).toBeLessThan(20);
    expect(plan.refusal).toBeUndefined();
  });

  it('refuses the 256K configuration that actually OOMKilled the pod', () => {
    // The evidence this module was corrected against: a limit computed without counting /dev/shm
    // was set at 20G, and the container was killed by its own staging buffers at exit 137.
    const plan = planHostMemory({ ...measured, inlineModelLoading: false });
    expect(plan.refusal).toMatch(/needs about/);
  });

  it('charges for inline loading, which is what the 21 GiB was', () => {
    // Same model, same GPUs, same VRAM — the only difference that mattered.
    const off = planHostMemory({ ...measured, inlineModelLoading: false });
    const on = planHostMemory({ ...measured, inlineModelLoading: true });

    expect(on.limitBytes).toBeGreaterThan(off.limitBytes);
    // Measured at 13.6 GB extra for a 19 GB model.
    expect((on.limitBytes - off.limitBytes) / 1e9).toBeGreaterThan(10);
  });

  it('refuses a deployment the node cannot hold, and says what to change', () => {
    // The whole point: the old floor produced a 32G limit on a 30 GiB machine and deployed anyway.
    const plan = planHostMemory({ ...measured, inlineModelLoading: true });

    expect(plan.refusal).toMatch(/needs about/);
    expect(plan.refusal).toMatch(/inline model loading/i);
    // Both numbers named — "it does not fit" without them is a dead end.
    expect(plan.refusal).toMatch(/allocatable/);
  });

  it('leaves the node room for everything that is not this pod', () => {
    // A pod permitted the whole node is the situation this module exists to prevent: the control
    // plane, the ingress and — on a workstation — a desktop session all live here too.
    const plan = planHostMemory({ ...measured, inlineModelLoading: false });
    expect(plan.budgetBytes).toBeLessThan(measured.allocatableBytes);
  });

  it('still plans when the node cannot be measured, but claims no budget', () => {
    // A cluster that will not answer is not a reason to fall back to a flat floor.
    const plan = planHostMemory({ ...measured, inlineModelLoading: false, allocatableBytes: undefined });

    expect(plan.limitBytes).toBeGreaterThan(0);
    expect(plan.budgetBytes).toBeUndefined();
    expect(plan.refusal).toBeUndefined();
  });

  it('assumes a large model when the size lookup failed, and says so', () => {
    // Guessing low OOMKills the pod during load, which reads as a broken image rather than as a
    // number someone chose.
    const plan = planHostMemory({
      ...measured, modelBytes: undefined, inlineModelLoading: true, allocatableBytes: 128 * 1024 ** 3,
    });

    expect(plan.basis).toMatch(/size lookup failed/);
    expect(plan.limitBytes).toBeGreaterThan(10e9);
  });

  it('sizes shared memory per shard, since tensor parallelism splits the weights', () => {
    // A flat 4Gi SIGBUSes the loader rather than raising — exit 135, no traceback.
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
    // `kubectl get node -o jsonpath=...allocatable.memory` returns Ki, not bytes.
    expect(parseQuantity('32800000Ki')).toBe(32800000 * 1024);
    expect(parseQuantity('30Gi')).toBe(30 * 1024 ** 3);
    expect(parseQuantity('8G')).toBe(8e9);
    expect(parseQuantity('1024')).toBe(1024);
  });

  it('returns undefined for something it does not understand, rather than zero', () => {
    // Zero would read as "no memory available" and refuse every deployment.
    expect(parseQuantity('lots')).toBeUndefined();
    expect(parseQuantity('')).toBeUndefined();
  });
});

describe('shared memory is inside the limit, not beside it', () => {
  it('includes /dev/shm in the container limit', () => {
    // tmpfs pages are charged to the cgroup that faults them, so a container with a 20G limit and
    // a 16Gi shm mount is OOMKilled by its own staging buffers. Measured: exit 137 mid-experiment
    // with 5 GiB resident in shared memory while the process was nowhere near the ceiling.
    const plan = planHostMemory({ ...measured, inlineModelLoading: false });
    expect(plan.limitBytes).toBeGreaterThan(plan.shmBytes);
    // The process needs real room ABOVE the shm mount, not merely as much as the mount.
    expect(plan.limitBytes - plan.shmBytes).toBeGreaterThan(5e9);
  });

  it('refuses when the weights plus their staging cannot fit the node', () => {
    // A model whose shards alone exceed the budget is not deployable here, however it is loaded.
    const plan = planHostMemory({
      modelBytes: 90e9, gpuCount: 1, maxSeqLen: 32768,
      inlineModelLoading: false, allocatableBytes: 30 * 1024 ** 3,
    });
    expect(plan.refusal).toMatch(/needs about/);
  });
});

describe('a chosen limit beats a computed one', () => {
  /**
   * The plan exists to save you from deciding, not to overrule you once you have.
   *
   * Reported live: the memory limit was changed in the UI, saved, redeployed — and the value
   * appeared nowhere in the Terraform plan. Two faults stacked. `DeployAppActivity` never forwarded
   * `tabbyMemoryLimit`, `tabbyShmSize` or `tabbyCpuLimit` to `buildAppEnv` at all, though
   * `TemporalBridge` had always sent them; and once forwarding was added, the computed plan
   * overwrote them unconditionally.
   *
   * The precedence rule is the same one the override chain uses everywhere else: the more specific
   * act wins, and typing a number is more specific than a default nobody chose.
   */
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
    // Allowed, not refused: it is the user's machine, and a too-small limit fails SAFELY — the
    // cgroup kills the pod instead of the host OOM killer taking the desktop with it.
    const plan = planHostMemory({ ...measured, maxSeqLen: 32768, inlineModelLoading: false });
    expect(parseQuantity('12G')!).toBeLessThan(plan.limitBytes);
  });
});

describe('a size lookup that fails quietly', () => {
  it('treats zero bytes as unknown, not as a very small model', () => {
    // getHfModelSize returns 0 rather than throwing when it cannot read a repo's file tree.
    // `?? 20e9` accepts 0, so the conservative fallback never ran and the plan produced 12G for a
    // model needing about 19G — the exact OOMKill the fallback exists to prevent.
    const zero = planHostMemory({ ...measured, modelBytes: 0, maxSeqLen: 32768, inlineModelLoading: false });
    const missing = planHostMemory({ ...measured, modelBytes: undefined, maxSeqLen: 32768, inlineModelLoading: false });

    expect(zero.limitBytes).toBe(missing.limitBytes);
    expect(zero.basis).toMatch(/size lookup failed/);
  });
});
