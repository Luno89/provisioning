import { describe, it, expect } from 'vitest';
import { PACK_SEEDS } from './pack-seeds.js';

/**
 * Six shipped packs carried a temperature in `overrides` — a real per-pack value, layered on at
 * call time. Deleting `overrides` without moving these would have retuned six personas to the
 * default 0.3 with nothing reporting it. This pins where each one landed.
 */
describe('the temperature each shipped pack was tuned to', () => {
  const at = (slug: string) => PACK_SEEDS.find((p) => p.slug === slug)!.sampling.toolTurn.temperature;

  it('keeps the value each persona had', () => {
    expect(at('framer')).toBe(0.3);
    expect(at('researcher')).toBe(0.4);
    expect(at('synthesist')).toBe(0.5);
    expect(at('merger')).toBe(0.2);
    expect(at('ingestor')).toBe(0.3);
    expect(at('judge')).toBe(0.1);
  });

  it('leaves the packs that set none at the shipped default', () => {
    for (const slug of ['koala', 'reviewer', 'builder']) expect(at(slug)).toBe(0.3);
  });
});
