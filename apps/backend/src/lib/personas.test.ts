import { describe, it, expect } from 'vitest';
import { validatePersona, MAX_PERSONA_PROMPT, validateLocalEgressRules } from './personas.js';
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

describe('validateLocalEgressRules', () => {
  it('allows nothing configured at all', () => {
    expect(validateLocalEgressRules(undefined)).toBeUndefined();
  });

  it('accepts a plain hostname, with or without ports', () => {
    expect(validateLocalEgressRules([{ host: 'registry.npmjs.org' }])).toBeUndefined();
    expect(validateLocalEgressRules([{ host: 'registry.npmjs.org', ports: [443] }])).toBeUndefined();
  });

  it('refuses a non-list', () => {
    expect(validateLocalEgressRules({ host: 'x' })).toMatch(/list of rules/);
  });

  it('refuses a rule with no host', () => {
    expect(validateLocalEgressRules([{ ports: [443] }])).toMatch(/needs a host/);
    expect(validateLocalEgressRules([{ host: '' }])).toMatch(/needs a host/);
  });

  it('refuses something that is not a valid hostname', () => {
    expect(validateLocalEgressRules([{ host: '10.0.0.0/8' }])).toMatch(/not a valid hostname/);
    expect(validateLocalEgressRules([{ host: 'not a host' }])).toMatch(/not a valid hostname/);
    expect(validateLocalEgressRules([{ host: '-leading-hyphen.com' }])).toMatch(/not a valid hostname/);
  });

  it('refuses an invalid port the same way validateEgressRules does', () => {
    expect(validateLocalEgressRules([{ host: 'x.com', ports: [0] }])).toMatch(/not a valid port/);
    expect(validateLocalEgressRules([{ host: 'x.com', ports: ['443'] }])).toMatch(/not a valid port/);
  });
});

