import { describe, it, expect } from 'vitest';
import {
  parseMemoryQuantity,
  parseCpuQuantity,
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

describe('checkCapacity', () => {
  const on = (capacity?: ClusterCapacity) => ({ name: 'desk', ...(capacity ? { capacity } : {}) });
  const small: ClusterCapacity = { cpuCores: 2, ramGb: 4 };
  const big: ClusterCapacity = { cpuCores: 16, ramGb: 64, gpuCount: 2, gpuVendor: 'nvidia' };

  it('blocks vLLM on a machine too small to ever schedule it', () => {
    const reason = checkCapacity('vllm', on(small));
    expect(reason).toMatch(/Pending/);
    expect(reason).toMatch(/4 GiB/);
  });

  it('allows vLLM on a machine with room', () => {
    expect(checkCapacity('vllm', on(big))).toBeUndefined();
  });

  it('does not block on a machine that satisfies REQUESTS, even though the limit is far larger', () => {
    const sixteenGb: ClusterCapacity = { cpuCores: 8, ramGb: 16 };
    expect(checkCapacity('vllm', on(sixteenGb))).toBeUndefined();
    expect(checkCapacity('tabbyapi', on(sixteenGb))).toBeUndefined();
  });

  it('refuses a model server on a machine that has not said how much memory it has, saying why and what makes it say', () => {
    expect(checkCapacity('vllm', on())).toBe('vLLM needs about 5.6 GiB of RAM, and desk has not said how much it has: its agent is from before machines reported their size, or it has not connected since. Once it connects with a current agent, it says.');
    expect(checkCapacity('tabbyapi', on())).toMatch(/^TabbyAPI needs about 5.6 GiB of RAM, and desk has not said how much it has/);
  });

  it('ignores app types with no recorded requirement, known size or not', () => {
    expect(checkCapacity('audiobookshelf', on(small))).toBeUndefined();
    expect(checkCapacity('audiobookshelf', on())).toBeUndefined();
  });
});
