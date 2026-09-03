import { describe, it, expect } from 'vitest';
import {
  TUNABLES,
  applyOverrides,
  validateOverrides,
  harnessDefaults,
  tunable,
  effectiveConfig,
} from './tunables.js';

import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

describe('every registered tunable reaches the wire', () => {
  const sampleFor = (type: string, spec: { min?: number; max?: number; options?: unknown[] }) => {
    if (type === 'boolean') return true;
    if (type === 'string') return 'sample';
    if (type === 'enum') return spec.options?.[0];
    const min = spec.min ?? 0;
    const max = spec.max ?? min + 10;
    return Math.round(((min + max) / 2) * 100) / 100;
  };

  for (const spec of TUNABLES) {
    if (spec.placement === 'loop') continue;

    it(`sends ${spec.key}`, () => {
      const value = sampleFor(spec.type, spec);
      const { body, unsupported } = applyOverrides({}, { [spec.key]: value }, spec.engine ?? 'tabbyapi');

      expect(unsupported).toEqual([]);
      const field = spec.field ?? spec.key;
      if (spec.placement === 'template_vars') {
        expect((body.template_vars as Record<string, unknown>)[field]).toEqual(value);
      } else {
        expect(body[field]).toEqual(value);
      }
    });
  }
});

describe('applyOverrides', () => {
  it('puts the thinking switch under template_vars, where the engine actually reads it', () => {
    const { body } = applyOverrides({}, { think: true }, 'tabbyapi');
    expect(body.template_vars).toEqual({ enable_thinking: true });
    expect(body.think).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it('merges into existing template_vars rather than replacing them', () => {
    const { body } = applyOverrides(
      { template_vars: { enable_thinking: false, other: 1 } },
      { think: true },
      'tabbyapi',
    );
    expect(body.template_vars).toEqual({ enable_thinking: true, other: 1 });
  });

  it('overrides the harness default rather than sitting behind it', () => {
    const { body } = applyOverrides({ temperature: 0.3 }, { temperature: 0.9 });
    expect(body.temperature).toBe(0.9);
  });

  it('drops an engine-specific sampler on another engine, and says which', () => {
    const { body, unsupported } = applyOverrides({}, { dry_multiplier: 0.8, temperature: 0.5 }, 'vllm');
    expect(body.dry_multiplier).toBeUndefined();
    expect(body.temperature).toBe(0.5);
    expect(unsupported).toEqual(['dry_multiplier']);
  });

  it('reports an unknown key instead of writing it onto the wire', () => {
    const { body, unsupported } = applyOverrides({}, { notAThing: 1 });
    expect(body.notAThing).toBeUndefined();
    expect(unsupported).toEqual(['notAThing']);
  });

  it('never sends loop-placement knobs, which the loop reads itself', () => {
    const { body, unsupported } = applyOverrides({}, { maxSteps: 8, systemPrompt: 'hi' }, 'tabbyapi');
    expect(body.maxSteps).toBeUndefined();
    expect(body.systemPrompt).toBeUndefined();
    expect(unsupported).toEqual([]);
  });

  it('ignores undefined, so an unset field is not sent as null', () => {
    const { body } = applyOverrides({ temperature: 0.3 }, { temperature: undefined });
    expect(body.temperature).toBe(0.3);
  });
});

describe('validateOverrides', () => {
  it('rejects a value outside the declared range', () => {
    expect(validateOverrides({ temperature: 5 })).toMatch(/at most 2/);
    expect(validateOverrides({ temperature: -1 })).toMatch(/at least 0/);
  });

  it('rejects the wrong type', () => {
    expect(validateOverrides({ temperature: 'hot' })).toMatch(/must be a number/);
    expect(validateOverrides({ think: 'yes' })).toMatch(/true or false/);
  });

  it('rejects an unknown key, so a typo is not silently a no-op variant', () => {
    expect(validateOverrides({ temprature: 0.5 })).toMatch(/Unknown setting/);
  });

  it('accepts null, which is the opt-out rather than a value', () => {
    expect(validateOverrides({ systemPrompt: null })).toBeNull();
    expect(validateOverrides({ temperature: null, think: null })).toBeNull();
  });

  it('accepts the harness defaults it ships with', () => {
    expect(validateOverrides(harnessDefaults('tabbyapi', PACK_SEEDS[0]!.sampling))).toBeNull();
    expect(validateOverrides(harnessDefaults(undefined, PACK_SEEDS[0]!.sampling))).toBeNull();
  });
});

describe('harnessDefaults', () => {
  it('is the control arm — stated values, not an empty object', () => {
    const defaults = harnessDefaults('tabbyapi', PACK_SEEDS[0]!.sampling);
    expect(defaults.temperature).toBe(0.3);
    expect(defaults.think).toBe(false);
    expect(defaults.dry_multiplier).toBe(0);
  });

  it('leaves engine-specific knobs out for an engine that cannot take them', () => {
    expect(harnessDefaults('vllm', PACK_SEEDS[0]!.sampling).dry_multiplier).toBeUndefined();
    expect(harnessDefaults(undefined, PACK_SEEDS[0]!.sampling).dry_multiplier).toBeUndefined();
  });

  it('states no sampler default of its own — the pack says what a knob is set to', () => {
    for (const key of ['temperature', 'frequency_penalty', 'dry_multiplier', 'dry_base', 'dry_allowed_length']) {
      expect(tunable(key)?.default, key).toBeUndefined();
    }
  });
});

describe('effectiveConfig', () => {
  it("is the pack's value when nothing has been adopted", () => {
    const live = effectiveConfig({}, 'tabbyapi', PACK_SEEDS[0]!.sampling);
    const temp = live.find((k) => k.key === 'temperature')!;
    expect(temp.value).toBe(0.3);
    expect(temp.source).toBe('harness');
  });

  it('is the ADOPTED value once a profile supplies one', () => {
    const live = effectiveConfig({ think: true, temperature: 0.9 }, 'tabbyapi');
    expect(live.find((k) => k.key === 'think')).toMatchObject({ value: true, source: 'adopted' });
    expect(live.find((k) => k.key === 'temperature')).toMatchObject({ value: 0.9, source: 'adopted' });
  });

  it('treats the null opt-out as not-adopted rather than as a value', () => {
    const live = effectiveConfig({ systemPrompt: null }, 'tabbyapi');
    expect(live.find((k) => k.key === 'systemPrompt')!.source).toBe('harness');
  });

  it('leaves out knobs the engine would drop anyway', () => {
    expect(effectiveConfig({}, 'vllm').some((k) => k.key === 'dry_multiplier')).toBe(false);
    expect(effectiveConfig({}, 'tabbyapi').some((k) => k.key === 'dry_multiplier')).toBe(true);
  });

  it('says where a value came from, since that changes where you go to alter it', () => {
    const live = effectiveConfig({ think: true }, 'tabbyapi');
    expect(live.find((k) => k.key === 'think')!.sourceFile).toBe('lib/sampling.ts');
  });
});

describe('the advertised token ceiling', () => {
  it('matches what the loop actually sends on a reasoning turn', () => {
    const maxTokens = TUNABLES.find((t) => t.key === 'max_tokens')!;
    expect(maxTokens.suggested).toEqual([BUDGET.replyTokens.tool, BUDGET.replyTokens.thinking]);
    // The note names the pack's cap rather than restating a number, since the number is the
    // pack's now and a note that restated it would drift the moment a pack was retuned.
    expect(maxTokens.note).toMatch(/Rises to the pack's thinking cap/);
  });
});
