import { describe, it, expect } from 'vitest';
import {
  vramMibFromNodeLabels,
  parseNvidiaSmiVram,
  vramGib,
  vramVerdict,
  GFD_MEMORY_LABEL,
} from './gpu-vram.js';

const node = (gpus: string | undefined, vramMib?: string) => ({
  metadata: { labels: vramMib === undefined ? {} : { [GFD_MEMORY_LABEL]: vramMib } },
  status: { allocatable: gpus === undefined ? {} : { 'nvidia.com/gpu': gpus } },
});

describe('vramMibFromNodeLabels', () => {
  it('reads the GFD label', () => {
    expect(vramMibFromNodeLabels({ items: [node('2', '24576')] })).toBe(24576);
  });

  it('takes the SMALLEST card across a mixed fleet, not the largest', () => {
    // Opposite of how host RAM is handled, and deliberately so: a pod lands on one node and gets
    // one GPU, so the smallest card is what a model must fit inside. Reporting the largest would
    // green-light a model that only fits on one of the nodes.
    expect(vramMibFromNodeLabels({ items: [node('1', '49152'), node('1', '24576')] })).toBe(24576);
  });

  it('ignores CPU-only nodes rather than letting them drag the minimum down', () => {
    expect(vramMibFromNodeLabels({ items: [node(undefined, undefined), node('2', '24576')] })).toBe(24576);
    expect(vramMibFromNodeLabels({ items: [node('0', '0'), node('2', '24576')] })).toBe(24576);
  });

  it('returns undefined when GFD is not installed — unknown, never zero', () => {
    // This is the live state of the management cluster: the device plugin publishes a count and
    // no label at all. Downstream must degrade to "cannot tell", not "no VRAM".
    expect(vramMibFromNodeLabels({ items: [node('2')] })).toBeUndefined();
  });

  it('survives malformed payloads', () => {
    expect(vramMibFromNodeLabels(undefined)).toBeUndefined();
    expect(vramMibFromNodeLabels({})).toBeUndefined();
    expect(vramMibFromNodeLabels({ items: [] })).toBeUndefined();
    expect(vramMibFromNodeLabels({ items: [node('2', 'not-a-number')] })).toBeUndefined();
  });
});

describe('parseNvidiaSmiVram', () => {
  it('parses the real output shape of --format=csv,noheader,nounits', () => {
    // Verified against the actual host: two RTX 3090s report 24576 apiece.
    expect(parseNvidiaSmiVram('24576\n24576\n')).toBe(24576);
  });

  it('takes the smallest when cards differ', () => {
    expect(parseNvidiaSmiVram('49152\n24576\n')).toBe(24576);
  });

  it('returns undefined for empty or error output rather than 0', () => {
    expect(parseNvidiaSmiVram('')).toBeUndefined();
    expect(parseNvidiaSmiVram('command not found')).toBeUndefined();
  });
});

describe('vramVerdict', () => {
  const GB = 1e9;
  const RTX_3090 = 24576; // MiB

  it('fits a model comfortably inside a 3090', () => {
    expect(vramVerdict(12 * GB, RTX_3090)?.fits).toBe(true);
  });

  it('refuses a model that exceeds the card', () => {
    const v = vramVerdict(30 * GB, RTX_3090);
    expect(v?.fits).toBe(false);
    // 24576 MiB is exactly 24 GiB — which is 25.8 GB. The message reports GiB because that is how
    // card capacity is universally quoted, while the estimate is in GB; mixing them up is the
    // easiest way to be off by 7% in the direction that says "it fits".
    expect(v?.message).toMatch(/24 GiB/);
  });

  it('refuses a model that fits on paper but leaves no headroom', () => {
    // 24576 MiB is ~25.8 GB; a 25 GB model "fits" arithmetically and then OOMs on load, because
    // the estimate covers weights and KV cache but not CUDA context, activations or whatever the
    // display server already holds.
    expect(vramVerdict(25 * GB, RTX_3090)?.fits).toBe(false);
  });

  it('returns undefined when either side is unknown, so callers cannot mistake it for a pass', () => {
    expect(vramVerdict(undefined, RTX_3090)).toBeUndefined();
    expect(vramVerdict(12 * GB, undefined)).toBeUndefined();
    expect(vramVerdict(undefined, undefined)).toBeUndefined();
  });
});

describe('vramGib', () => {
  it('converts MiB to GiB', () => {
    expect(vramGib(24576)).toBe(24);
    expect(vramGib(49152)).toBe(48);
  });
});
