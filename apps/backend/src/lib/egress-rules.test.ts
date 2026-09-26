import { describe, it, expect } from 'vitest';
import { validateLocalEgressRules } from './egress-rules.js';

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

