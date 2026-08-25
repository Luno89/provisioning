import { describe, it, expect } from 'vitest';
import { getPersonaPack, KOALA_PACK, HARNESS_PACK, type PersonaPack } from './persona-pack.js';

/**
 * PersonaPacks: a persona plus the runtime it selects — the model, environment, and delivery
 * (what the UI sees on the shared wire). The point is that every knob is a field of a record,
 * so adding a conversation type is editing a pack, never a route.
 *
 * TDD: these tests were written first; the zero test (the registry serves the koala + harness
 * packs with a granular delivery) drove the spec's existence.
 */
describe('the persona-pack registry', () => {
  it('serves the koala pack', () => {
    const p = getPersonaPack('koala');
    expect(p).toBeDefined();
    expect(p.persona).toBe('Koala');
  });

  it('serves the harness/workbench pack', () => {
    const p = getPersonaPack('harness');
    expect(p).toBeDefined();
    expect(p.persona).toMatch(/harness|workbench/i);
  });

  it('rejects an unknown pack loudly', () => {
    expect(() => getPersonaPack('nope')).toThrow();
  });
});

describe('KOALA_PACK', () => {
  const pack: PersonaPack = KOALA_PACK;
  it('is an assistant environment with semantic tools', () => {
    expect(pack.env.toolset).toBe('assistant');
    expect(pack.env.context).toBe('vault');
  });
  it('renders proposals and enable frames — the cards and pills are its raison d\u00eatre', () => {
    expect(pack.delivery.proposals).toBe(true);
    expect(pack.delivery.toolResults).toBe(true);
    expect(pack.delivery.enable).toBe(true);
  });
  it('keeps usage and plan hidden — a chat, not a console', () => {
    expect(pack.delivery.usage).toBe(false);
    expect(pack.delivery.plan).toBe(false);
  });
});

describe('HARNESS_PACK', () => {
  const p: PersonaPack = HARNESS_PACK;
  it('is a workbench environment that settles leaf proposals', () => {
    expect(p.env.toolset).toBe('workbench');
    expect(p.workflow).toBe('workbench-settle');
  });
  it('is a transparency console: shows thinking, plan, and telemetry', () => {
    expect(p.delivery.thinking).toBe(true);
    expect(p.delivery.plan).toBe(true);
    expect(p.delivery.telemetry).toBe(true);
  });
  it('still surfaces tool results and proposals (the cards work here too)', () => {
    expect(p.delivery.tools).toBe('semantic');
    expect(p.delivery.toolResults).toBe(true);
    expect(p.delivery.proposals).toBe(true);
  });
});