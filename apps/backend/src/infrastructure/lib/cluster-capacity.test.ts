import { describe, it, expect } from 'vitest';
import {
  parseMemoryQuantity,
  parseCpuQuantity,
  capacityFromNodes,
  requestedGpuCount,
  checkCapacity,
  type ClusterCapacity,
} from './cluster-capacity.js';

describe('parseMemoryQuantity', () => {
  it('parses what a node actually reports', () => {
    expect(parseMemoryQuantity('16265432Ki')).toBe(16265432 * 1024);
  });

  it('keeps binary and decimal suffixes distinct — 20G is NOT 20Gi', () => {
    expect(parseMemoryQuantity('20G')).toBe(20e9);
    expect(parseMemoryQuantity('20Gi')).toBe(20 * 1024 ** 3);
    expect(parseMemoryQuantity('20G')).not.toBe(parseMemoryQuantity('20Gi'));
  });

  it('handles a bare byte count and exponent notation', () => {
    expect(parseMemoryQuantity('1024')).toBe(1024);
    expect(parseMemoryQuantity('1.5e3')).toBe(1500);
  });

  it('returns undefined rather than guessing at garbage', () => {
    expect(parseMemoryQuantity('twenty gigs')).toBeUndefined();
    expect(parseMemoryQuantity('20QB')).toBeUndefined();
    expect(parseMemoryQuantity('')).toBeUndefined();
    expect(parseMemoryQuantity(undefined)).toBeUndefined();
  });
});

describe('parseCpuQuantity', () => {
  it('parses whole cores and millicores', () => {
    expect(parseCpuQuantity('8')).toBe(8);
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
    const sixteenGb: ClusterCapacity = { cpuCores: 8, ramGb: 16 };
    expect(checkCapacity('vllm', sixteenGb)).toBeUndefined();
    expect(checkCapacity('tabbyapi', sixteenGb)).toBeUndefined();
  });

  it('NEVER blocks when capacity is unknown', () => {
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
    expect(checkCapacity('vllm', big, 4)).toMatch(/GPU/);
    expect(checkCapacity('vllm', big, 4)).not.toMatch(/GiB/);
  });
});

describe('requestedGpuCount', () => {
  const wizardPayload = {
    name: 'Wordpress-E2E',
    appType: 'wordpress',
    tabbyGpuCount: '2',
    vllmGpuCount: 1,
  };

  it('is zero for an app that does not use GPUs, whatever else is on the payload', () => {
    expect(requestedGpuCount('wordpress', wizardPayload)).toBe(0);
    expect(requestedGpuCount('odoo', wizardPayload)).toBe(0);
    expect(requestedGpuCount('nextcloud', wizardPayload)).toBe(0);
  });

  it('reads only the field belonging to the app being deployed', () => {
    expect(requestedGpuCount('tabbyapi', wizardPayload)).toBe(2);
    expect(requestedGpuCount('vllm', wizardPayload)).toBe(1);
  });

  it('treats a missing, empty or unparseable count as none requested', () => {
    expect(requestedGpuCount('tabbyapi', {})).toBe(0);
    expect(requestedGpuCount('tabbyapi', { tabbyGpuCount: '' })).toBe(0);
    expect(requestedGpuCount('tabbyapi', { tabbyGpuCount: 'two' })).toBe(0);
  });

  it('accepts the count as a string, which is what the wizard sends', () => {
    expect(requestedGpuCount('vllm', { vllmGpuCount: '4' })).toBe(4);
  });

  it('lets a WordPress deploy through a GPU-less cluster', () => {
    const noGpus = { cpuCores: 8, ramGb: 16, gpuCount: 0 };
    expect(checkCapacity('wordpress', noGpus, requestedGpuCount('wordpress', wizardPayload)))
      .toBeUndefined();
    expect(checkCapacity('tabbyapi', noGpus, requestedGpuCount('tabbyapi', wizardPayload)))
      .toMatch(/no GPUs are visible/);
  });
});
