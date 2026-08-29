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
    expect(vramMibFromNodeLabels({ items: [node('1', '49152'), node('1', '24576')] })).toBe(24576);
  });

  it('ignores CPU-only nodes rather than letting them drag the minimum down', () => {
    expect(vramMibFromNodeLabels({ items: [node(undefined, undefined), node('2', '24576')] })).toBe(24576);
    expect(vramMibFromNodeLabels({ items: [node('0', '0'), node('2', '24576')] })).toBe(24576);
  });

  it('returns undefined when GFD is not installed — unknown, never zero', () => {
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
  const RTX_3090 = 24576;

  it('fits a model comfortably inside a 3090', () => {
    expect(vramVerdict(12 * GB, RTX_3090)?.fits).toBe(true);
  });

  it('refuses a model that exceeds the card', () => {
    const v = vramVerdict(30 * GB, RTX_3090);
    expect(v?.fits).toBe(false);
    expect(v?.message).toMatch(/24 GiB/);
  });

  it('refuses a model that fits on paper but leaves no headroom', () => {
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
