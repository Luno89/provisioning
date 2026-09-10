import { describe, it, expect } from 'vitest';
import { validateCustomStepDefinition, renderCustomStepCommand, type CustomStepDefinition } from './custom-steps.js';

const def = (over: Partial<CustomStepDefinition> = {}): CustomStepDefinition => ({
  id: 'lighthouse-check',
  ownerId: 'u1',
  name: 'Lighthouse score check',
  fields: [{ key: 'url', label: 'URL', kind: 'string' }, { key: 'minScore', label: 'Min score', kind: 'number', defaultValue: 90 }],
  command: 'lighthouse {{url}} --min-score={{minScore}}',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('validateCustomStepDefinition', () => {
  it('accepts a complete definition', () => {
    expect(validateCustomStepDefinition(def())).toBeNull();
  });

  it('refuses an id that is not a slug', () => {
    expect(validateCustomStepDefinition(def({ id: 'Not A Slug' }))).toMatch(/id/i);
  });

  it('refuses a missing name or command', () => {
    const { name: _n, ...noName } = def();
    expect(validateCustomStepDefinition(noName)).toMatch(/name/i);
    const { command: _c, ...noCommand } = def();
    expect(validateCustomStepDefinition(noCommand)).toMatch(/command/i);
  });

  it('refuses a field key that is not a valid identifier', () => {
    expect(validateCustomStepDefinition(def({ fields: [{ key: '1bad', label: 'x', kind: 'string' }] }))).toMatch(/key/i);
  });

  it('refuses duplicate field keys', () => {
    expect(validateCustomStepDefinition(def({
      fields: [{ key: 'x', label: 'A', kind: 'string' }, { key: 'x', label: 'B', kind: 'number' }],
    }))).toMatch(/used more than once/i);
  });

  it('refuses a field with no label or an unknown kind', () => {
    expect(validateCustomStepDefinition(def({ fields: [{ key: 'x', label: '', kind: 'string' }] }))).toMatch(/label/i);
    expect(validateCustomStepDefinition(def({ fields: [{ key: 'x', label: 'X', kind: 'array' as never }] }))).toMatch(/kind/i);
  });

  it('refuses a non-positive timeoutMs', () => {
    expect(validateCustomStepDefinition(def({ timeoutMs: 0 }))).toMatch(/timeoutMs/i);
    expect(validateCustomStepDefinition(def({ timeoutMs: -5 }))).toMatch(/timeoutMs/i);
  });
});

describe('renderCustomStepCommand', () => {
  it('substitutes field values into the command template', () => {
    const cmd = renderCustomStepCommand(def(), { url: 'https://example.com', minScore: 95 });
    expect(cmd).toBe('lighthouse https://example.com --min-score=95');
  });

  it('falls back to a field default when no param value is given', () => {
    const cmd = renderCustomStepCommand(def(), { url: 'https://example.com' });
    expect(cmd).toBe('lighthouse https://example.com --min-score=90');
  });

  it('leaves an unmatched placeholder alone rather than dropping it silently', () => {
    const cmd = renderCustomStepCommand(
      { fields: [], command: 'echo {{ghost}}' },
      {},
    );
    expect(cmd).toBe('echo {{ghost}}');
  });
});
