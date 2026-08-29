import { describe, it, expect } from 'vitest';
import { resolveConfig, validatePersona, MAX_PERSONA_PROMPT } from './personas.js';
import type { Persona } from '@koala/harness-types';
import type { HarnessProfile } from './harness-profile.js';

const profile = (overrides: Record<string, unknown>): HarnessProfile =>
  ({ ownerId: 'u1', overrides, updatedAt: '2026-08-07T00:00:00.000Z' } as HarnessProfile);

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: 'p1', ownerId: 'u1', name: 'Reviewer',
  createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z',
  ...over,
});

const pack = (overrides: Record<string, unknown> = {}) => ({ overrides });

describe('resolveConfig', () => {
  it('narrows scope at each step: profile, then pack, then request', () => {
    const resolved = resolveConfig(
      profile({ temperature: 0, think: false }),
      pack({ temperature: 0.4 }),
      { temperature: 0.9 },
    );

    expect(resolved.overrides.temperature).toBe(0.9);
    expect(resolved.overrides.think).toBe(false);
  });

  it('records which layer supplied each key', () => {
    const resolved = resolveConfig(
      profile({ temperature: 0, think: false, maxSteps: 12 }),
      pack({ temperature: 0.4 }),
      { maxSteps: 30 },
    );

    expect(resolved.from).toEqual({
      pack: ['temperature'], profile: ['think'], request: ['maxSteps'],
    });
  });

  it('lets a later layer opt out of an adopted default without knowing its value', () => {
    const resolved = resolveConfig(
      profile({ temperature: 0, think: true }),
      pack({ think: null }),
    );

    expect('think' in resolved.overrides).toBe(false);
    expect(resolved.from.pack).toEqual([]);
    expect(resolved.from.profile).toEqual(['temperature']);
  });

  it('carries the persona prompt separately from the sampler bag', () => {
    const resolved = resolveConfig(null, null, {}, persona({ systemPrompt: 'You review code.' }));

    expect(resolved.systemPrompt).toBe('You review code.');
    expect(resolved.overrides.systemPrompt).toBeUndefined();
  });

  it('prefers the persona’s own prompt over one left in its overrides bag', () => {
    const resolved = resolveConfig(
      null,
      pack({ systemPrompt: 'stale' }),
      {},
      persona({ systemPrompt: 'current' }),
    );

    expect(resolved.systemPrompt).toBe('current');
  });

  it('still resolves with no profile and no persona, which is most turns', () => {
    const resolved = resolveConfig(null, null, { temperature: 0.5 });

    expect(resolved.overrides).toEqual({ temperature: 0.5 });
    expect(resolved.from).toEqual({ pack: [], profile: [], request: ['temperature'] });
    expect(resolved.systemPrompt).toBeUndefined();
  });

  it('treats a blank persona prompt as no prompt rather than an empty system message', () => {
    const resolved = resolveConfig(null, null, {}, persona({ systemPrompt: '   ' }));
    expect(resolved.systemPrompt).toBeUndefined();
  });
});

describe('validatePersona', () => {
  it('refuses two personas with the same name, since the picker shows names', () => {
    const existing = [persona({ id: 'p1', name: 'Reviewer' })];
    expect(validatePersona({ name: 'reviewer' }, existing)).toMatch(/already have a persona/);
  });

  it('lets a persona keep its own name when edited', () => {
    const existing = [persona({ id: 'p1', name: 'Reviewer' })];
    expect(validatePersona({ name: 'Reviewer' }, existing, 'p1')).toBeUndefined();
  });

  it('requires a name', () => {
    expect(validatePersona({ name: '  ' }, [])).toMatch(/needs a name/);
  });

  it('caps the prompt, because a system message is paid for on every turn', () => {
    const tooLong = { name: 'Verbose', systemPrompt: 'x'.repeat(MAX_PERSONA_PROMPT + 1) };
    expect(validatePersona(tooLong, [])).toMatch(/characters or fewer/);
  });
});

describe('the pack layer', () => {
  it('supplies the runtime, and the persona supplies only the prompt', () => {
    const resolved = resolveConfig(
      null,
      pack({ temperature: 0.1 }),
      {},
      persona({ systemPrompt: 'Terse.' }),
    );
    expect(resolved.overrides.temperature).toBe(0.1);
    expect(resolved.systemPrompt).toBe('Terse.');
    expect(resolved.from.pack).toEqual(['temperature']);
  });

  it('loses to the request, which is this one turn', () => {
    const resolved = resolveConfig(null, pack({ temperature: 0.1 }), { temperature: 0.9 });
    expect(resolved.overrides.temperature).toBe(0.9);
    expect(resolved.from.request).toEqual(['temperature']);
  });

  it('beats the profile, which is a standing default', () => {
    const resolved = resolveConfig(profile({ temperature: 0.5 }), pack({ temperature: 0.1 }));
    expect(resolved.overrides.temperature).toBe(0.1);
    expect(resolved.from.pack).toEqual(['temperature']);
    expect(resolved.from.profile).toEqual([]);
  });
});

describe('packs as experiment arms', () => {
  const terse = pack({ temperature: 0.1 });
  const curious = pack({ temperature: 0.9, think: true });

  it('gives each arm its own complete runtime', () => {
    expect(resolveConfig(null, terse).overrides.temperature).toBe(0.1);
    expect(resolveConfig(null, curious).overrides.temperature).toBe(0.9);
    expect(resolveConfig(null, curious).overrides.think).toBe(true);
  });

  it('lets an arm borrow a pack and change one knob', () => {
    const hotter = resolveConfig(null, terse, { temperature: 0.8 }, persona({ systemPrompt: 'Terse.' }));
    expect(hotter.overrides.temperature).toBe(0.8);
    expect(hotter.systemPrompt).toBe('Terse.');
    expect(hotter.from).toEqual({ pack: [], profile: [], request: ['temperature'] });
  });

  it('keeps pack and profile provenance apart in the record', () => {
    const resolved = resolveConfig(profile({ maxSteps: 20 }), curious, {});
    expect(resolved.from.profile).toEqual(['maxSteps']);
    expect(resolved.from.pack).toEqual(['temperature', 'think']);
  });
});
