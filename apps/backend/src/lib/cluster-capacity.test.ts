import { describe, it, expect } from 'vitest';
import {
  parseMemoryQuantity,
  parseCpuQuantity,
  capacityFromNodes,
  checkCapacity,
  type ClusterCapacity,
} from './cluster-capacity.js';

describe('parseMemoryQuantity', () => {
  it('parses what a node actually reports', () => {
    // Real shape from `kubectl get nodes -o json` — always Ki, never a round number.
    expect(parseMemoryQuantity('16265432Ki')).toBe(16265432 * 1024);
  });

  it('keeps binary and decimal suffixes distinct — 20G is NOT 20Gi', () => {
    // The bug this guards: 20G is 20e9 bytes (18.6 GiB). Treating it as 20 GiB overstates by ~7%,
    // which looks like a flaky scheduler rather than a unit error.
    expect(parseMemoryQuantity('20G')).toBe(20e9);
    expect(parseMemoryQuantity('20Gi')).toBe(20 * 1024 ** 3);
    expect(parseMemoryQuantity('20G')).not.toBe(parseMemoryQuantity('20Gi'));
  });

  it('handles a bare byte count and exponent notation', () => {
    expect(parseMemoryQuantity('1024')).toBe(1024);
    expect(parseMemoryQuantity('1.5e3')).toBe(1500);
  });

  it('returns undefined rather than guessing at garbage', () => {
    // A wrong number here silently blocks or admits a deploy, so unparseable must stay unparseable.
    expect(parseMemoryQuantity('twenty gigs')).toBeUndefined();
    expect(parseMemoryQuantity('20QB')).toBeUndefined();
    expect(parseMemoryQuantity('')).toBeUndefined();
    expect(parseMemoryQuantity(undefined)).toBeUndefined();
  });
});

describe('parseCpuQuantity', () => {
  it('parses whole cores and millicores', () => {
    expect(parseCpuQuantity('8')).toBe(8);
    // Allocatable is normally millicores — the kubelet reserves a slice for itself.
    expect(parseCpuQuantity('7900m')).toBe(7.9);
  });

  it('returns undefined for garbage', () => {
    expect(parseCpuQuantity('lots')).toBeUndefined();
    expect(parseCpuQuantity(undefined)).toBeUndefined();
  });
});

const node = (memory: string, cpu: string, extra: Record<string, string> = {}) => ({
  status: { allocatable: { memory, cpu, ...extra } },
});

describe('capacityFromNodes', () => {
  it('reads a single node', () => {
    const cap = capacityFromNodes({ items: [node('16265432Ki', '7900m')] });
    expect(cap?.cpuCores).toBe(7.9);
    expect(cap?.ramGb).toBeCloseTo(15.5, 1);
    expect(cap?.gpuCount).toBeUndefined();
  });

  it('takes the largest node, not the sum — a pod cannot span nodes', () => {
    // The bug this guards: summing reports 24GB for three 8GB nodes, then a 20GB pod still cannot
    // schedule anywhere.
    const cap = capacityFromNodes({
      items: [node('8Gi', '4'), node('8Gi', '4'), node('8Gi', '4')],
    });
    expect(cap?.ramGb).toBe(8);
    expect(cap?.cpuCores).toBe(4);
  });

  it('reports GPUs as a count with a vendor', () => {
    const cap = capacityFromNodes({ items: [node('64Gi', '16', { 'nvidia.com/gpu': '2' })] });
    expect(cap?.gpuCount).toBe(2);
    expect(cap?.gpuVendor).toBe('nvidia');
  });

  it('recognises AMD GPUs too', () => {
    const cap = capacityFromNodes({ items: [node('64Gi', '16', { 'amd.com/gpu': '1' })] });
    expect(cap?.gpuCount).toBe(1);
    expect(cap?.gpuVendor).toBe('amd');
  });

  it('omits gpuCount entirely when there are none, rather than reporting 0', () => {
    // Absent means "none measured"; checkCapacity treats absent capacity as unknown, so the
    // difference matters.
    const cap = capacityFromNodes({ items: [node('8Gi', '4')] });
    expect(cap).not.toHaveProperty('gpuCount');
  });

  it('returns undefined for an empty or malformed payload instead of a zeroed record', () => {
    expect(capacityFromNodes({ items: [] })).toBeUndefined();
    expect(capacityFromNodes({})).toBeUndefined();
    expect(capacityFromNodes(undefined)).toBeUndefined();
    expect(capacityFromNodes({ items: [{}] })).toBeUndefined();
  });
});

describe('checkCapacity', () => {
  const small: ClusterCapacity = { cpuCores: 2, ramGb: 4 };
  const big: ClusterCapacity = { cpuCores: 16, ramGb: 64, gpuCount: 2, gpuVendor: 'nvidia' };

  it('blocks vLLM on a node too small to ever schedule it', () => {
    const reason = checkCapacity('vllm', small);
    expect(reason).toMatch(/Pending/);
    expect(reason).toMatch(/4 GiB/);
  });

  it('allows vLLM on a node with room', () => {
    expect(checkCapacity('vllm', big)).toBeUndefined();
  });

  it('does not block on a node that satisfies REQUESTS, even though the limit is far larger', () => {
    // The bug this pins. The requirement table originally held the constructs' `limits` (20G for
    // vLLM, 32G for TabbyAPI), but Kubernetes schedules on `requests` — both constructs request
    // only 6G. Checking the limit refused deploys onto a 16GiB box that would have scheduled and
    // run fine, which is the false rejection this module explicitly refuses to make.
    const sixteenGb: ClusterCapacity = { cpuCores: 8, ramGb: 16 };
    expect(checkCapacity('vllm', sixteenGb)).toBeUndefined();
    expect(checkCapacity('tabbyapi', sixteenGb)).toBeUndefined();
  });

  it('NEVER blocks when capacity is unknown', () => {
    // Clusters provisioned before capacity was recorded have no numbers. Refusing to deploy to
    // them would be a worse regression than the Pending pod this check exists to prevent.
    expect(checkCapacity('vllm', undefined)).toBeUndefined();
    expect(checkCapacity('vllm', undefined, 4)).toBeUndefined();
  });

  it('ignores app types with no recorded requirement', () => {
    expect(checkCapacity('audiobookshelf', small)).toBeUndefined();
  });

  it('blocks a GPU request on a cluster with no GPUs', () => {
    expect(checkCapacity('vllm', big, 1)).toBeUndefined();
    expect(checkCapacity('openwebui', { cpuCores: 8, ramGb: 32 }, 1)).toMatch(/no GPUs are visible/);
  });

  it('blocks a request for more GPUs than any single node has', () => {
    expect(checkCapacity('openwebui', big, 4)).toMatch(/largest node on this cluster has 2/);
  });

  it('compares GPU count to GPU count, never against RAM', () => {
    // A 64 GiB box with 2 GPUs must not satisfy a 4-GPU request just because it has plenty of RAM.
    // This is the RAM/VRAM conflation the module exists to prevent, in its most likely form.
    expect(checkCapacity('vllm', big, 4)).toMatch(/GPU/);
    expect(checkCapacity('vllm', big, 4)).not.toMatch(/GiB/);
  });
});
