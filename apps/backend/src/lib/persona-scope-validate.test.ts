import { describe, it, expect } from 'vitest';
import { validateScope } from './personas.js';

describe('validating what a persona may reach', () => {
  it('accepts an absent scope', () => {
    expect(validateScope(undefined)).toBeUndefined();
  });

  it('accepts the two egress forms', () => {
    expect(validateScope({ egress: [{ namespace: 'gitea', ports: [3000] }] })).toBeUndefined();
    expect(validateScope({ egress: [{ cidr: '10.0.0.0/8', ports: [443] }] })).toBeUndefined();
  });

  it('refuses a rule that names both or neither', () => {
    expect(validateScope({ egress: [{ namespace: 'gitea', cidr: '10.0.0.0/8' }] })).toMatch(/exactly one/i);
    expect(validateScope({ egress: [{ ports: [443] }] })).toMatch(/exactly one/i);
  });

  it('refuses a malformed CIDR or namespace', () => {
    expect(validateScope({ egress: [{ cidr: 'registry.npmjs.org' }] })).toMatch(/valid CIDR/i);
    expect(validateScope({ egress: [{ cidr: '10.0.0.0' }] })).toMatch(/valid CIDR/i);
    expect(validateScope({ egress: [{ namespace: 'Not A Namespace' }] })).toMatch(/valid namespace/i);
  });

  it('refuses an impossible port', () => {
    expect(validateScope({ egress: [{ namespace: 'gitea', ports: [70000] }] })).toMatch(/valid port/i);
    expect(validateScope({ egress: [{ namespace: 'gitea', ports: [0] }] })).toMatch(/valid port/i);
  });

  it('checks the rest of the shape', () => {
    expect(validateScope({ tools: 'run_command' })).toMatch(/list of tool names/i);
    expect(validateScope({ repo: 'yes' })).toMatch(/true or false/i);
    expect(validateScope([])).toMatch(/must be an object/i);
  });

  it('accepts a full scope of the kind the seeds create', () => {
    expect(validateScope({
      language: 'node', repo: true, tools: ['run_command', 'write_file', 'finish'],
      egress: [{ namespace: 'gitea', ports: [3000] }], run: { maxSteps: 40 },
    })).toBeUndefined();
  });
});
