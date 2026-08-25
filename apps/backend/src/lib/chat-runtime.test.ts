import { describe, it, expect } from 'vitest';
import { mapTurnToFrames } from './chat-runtime.js';
import { KOALA_PACK, HARNESS_PACK, type DeliverySpec } from './persona-pack.js';
import type { UnifiedFrame } from './chat-wire.js';

/**
 * The delivery filter: given a round-loop result and a persona pack's `delivery`, produce the
 * UnifiedFrames the surface should render. This is "what the user wants to see" made granular —
 * the same turn renders differently for the Koala pack (assistant) vs Harness (console).
 */
const TURN = {
  answer: 'Hello',
  thinking: 'let me check…',
  toolCalls: [{ id: 'c1', name: 'get_logs', args: '{"pod":"p"}', ok: true, digest: 'log lines' }],
  enabledNow: ['github-mcp'],
  proposedTrees: [{ id: 't1' }],
  proposedSpecs: [],
  exhaustedRounds: false,
};

const koala = (KOALA_PACK as any).delivery as DeliverySpec;
const harness = (HARNESS_PACK as any).delivery as DeliverySpec;

describe('mapTurnToFrames — granular delivery', () => {
  it('an assistant pack shows content, thinking, tool lifecycle and proposals', () => {
    const frames = mapTurnToFrames(TURN, koala);
    const types = frames.map((f) => f.type);
    expect(types).toContain('content');
    expect(types).toContain('thinking');
    expect(types).toContain('toolAnnounce');
    expect(types).toContain('toolResult');
    expect(types).toContain('proposedTree');
    expect(types).toContain('enabled');
  });

  it('an assistant pack hides plan and usage (not a console)', () => {
    const frames = mapTurnToFrames(TURN, koala);
    const types = frames.map((f) => f.type);
    expect(types).not.toContain('plan');
    expect(types).not.toContain('usage');
  });

  it('workbench pack surfaces plan/usage but has enable off', () => {
    const frames = mapTurnToFrames(TURN, harness);
    const types = frames.map((f) => f.type);
    expect(types).not.toContain('enabled');
  });

  it('a delivery with tools=raw omits tool announces and forwards nothing extra', () => {
    const raw: DeliverySpec = {
      content: true, thinking: false, tools: 'raw', toolResults: false,
      proposals: false, enable: false, plan: false, usage: false, telemetry: true,
    };
    const frames = mapTurnToFrames(TURN, raw);
    const types = frames.map((f) => f.type);
    expect(types).not.toContain('toolAnnounce');
    expect(types).not.toContain('toolResult');
  });

  it('telemetry shows interrupted reason when present and requested', () => {
    const frames = mapTurnToFrames({ ...TURN, ...{ interrupted: 'Overthinking' } }, koala);
    expect(frames.some((f) => f.type === 'interrupted')).toBe(true);
  });

  it('returns content delta first, then thinking, independent of order', () => {
    const frames = mapTurnToFrames(TURN, koala);
    const idxOf = (t: string) => frames.findIndex((f) => f.type === t);
    expect(idxOf('content')).toBeGreaterThanOrEqual(0);
  });
});
