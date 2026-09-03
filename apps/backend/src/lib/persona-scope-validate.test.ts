import { describe, it, expect } from 'vitest';
import { validateEgressRules } from './personas.js';

describe('validating a tree type\'s egress rules', () => {
  it('accepts absent egress', () => {
    expect(validateEgressRules(undefined)).toBeUndefined();
  });

  it('accepts the two egress forms', () => {
    expect(validateEgressRules([{ namespace: 'gitea', ports: [3000] }])).toBeUndefined();
    expect(validateEgressRules([{ cidr: '10.0.0.0/8', ports: [443] }])).toBeUndefined();
  });

  it('refuses a rule that names both or neither', () => {
    expect(validateEgressRules([{ namespace: 'gitea', cidr: '10.0.0.0/8' }])).toMatch(/exactly one/i);
    expect(validateEgressRules([{ ports: [443] }])).toMatch(/exactly one/i);
  });

  it('refuses a malformed CIDR or namespace', () => {
    expect(validateEgressRules([{ cidr: 'registry.npmjs.org' }])).toMatch(/valid CIDR/i);
    expect(validateEgressRules([{ cidr: '10.0.0.0' }])).toMatch(/valid CIDR/i);
    expect(validateEgressRules([{ namespace: 'Not A Namespace' }])).toMatch(/valid namespace/i);
  });

  it('refuses an impossible port', () => {
    expect(validateEgressRules([{ namespace: 'gitea', ports: [70000] }])).toMatch(/valid port/i);
    expect(validateEgressRules([{ namespace: 'gitea', ports: [0] }])).toMatch(/valid port/i);
  });

  it('refuses a non-array', () => {
    expect(validateEgressRules({})).toMatch(/must be a list/i);
  });
});
