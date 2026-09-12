import { describe, it, expect } from 'vitest';
import {
  approvalFor,
  capabilitiesOf,
  lifecycleFor,
  poolable,
  satisfies,
  specFingerprint,
  unmetRequirements,
  type EnvironmentSpec,
} from './environment.js';

const sandbox = (over: Partial<EnvironmentSpec> = {}): EnvironmentSpec => ({
  kind: 'sandbox',
  lifecycle: 'invocation',
  languages: ['node20'],
  ...over,
});

describe('capabilitiesOf', () => {
  it('gives a sandbox a terminal, files, git and egress by default', () => {
    expect(capabilitiesOf(sandbox())).toEqual({
      terminal: true,
      filesystem: true,
      egress: true,
      git: true,
      languages: ['node20'],
    });
  });

  it('honours an explicitly closed network', () => {
    expect(capabilitiesOf(sandbox({ egress: false })).egress).toBe(false);
  });

  it('gives a no-environment run nothing but optional egress', () => {
    expect(capabilitiesOf({ kind: 'none', lifecycle: 'invocation' })).toMatchObject({
      terminal: false,
      filesystem: false,
      git: false,
      egress: false,
    });
    expect(capabilitiesOf({ kind: 'none', lifecycle: 'invocation', egress: true }).egress).toBe(true);
  });
});

describe('lifecycle and approval follow the environment type', () => {
  it('makes a machine persistent and command-approved', () => {
    expect(lifecycleFor('machine')).toBe('persistent');
    expect(approvalFor('machine')).toBe('per-command');
  });

  it('scopes a sandbox to the invocation and needs no approval', () => {
    expect(lifecycleFor('sandbox')).toBe('invocation');
    expect(approvalFor('sandbox')).toBe('none');
  });
});

describe('unmetRequirements', () => {
  const none = capabilitiesOf({ kind: 'none', lifecycle: 'invocation' });

  it('passes when everything asked for is present', () => {
    expect(unmetRequirements({ terminal: true, git: true, languages: ['node20'] }, capabilitiesOf(sandbox()))).toEqual([]);
    expect(satisfies({ terminal: true }, capabilitiesOf(sandbox()))).toBe(true);
  });

  it('explains a missing terminal in plain words', () => {
    expect(unmetRequirements({ terminal: true }, none)).toEqual([
      { need: 'terminal', detail: 'this environment cannot run commands' },
    ]);
  });

  it('catches a research agent needing egress the target cannot give', () => {
    const offline = capabilitiesOf(sandbox({ egress: false }));
    expect(unmetRequirements({ egress: true }, offline)).toEqual([
      { need: 'egress', detail: 'this environment cannot reach the network' },
    ]);
    expect(satisfies({ egress: true }, offline)).toBe(false);
  });

  it('catches a missing language by name', () => {
    expect(unmetRequirements({ languages: ['python312'] }, capabilitiesOf(sandbox()))).toEqual([
      { need: 'language:python312', detail: 'this environment does not have python312' },
    ]);
  });

  it('reports every unmet requirement at once rather than the first', () => {
    expect(unmetRequirements({ terminal: true, egress: true, git: true }, none)).toHaveLength(3);
  });
});

describe('specFingerprint', () => {
  it('is stable across key order and undefined fields', () => {
    const a: EnvironmentSpec = { kind: 'sandbox', lifecycle: 'invocation', languages: ['node20'], packages: ['ripgrep'] };
    const b: EnvironmentSpec = { packages: ['ripgrep'], languages: ['node20'], lifecycle: 'invocation', kind: 'sandbox', env: undefined };
    expect(specFingerprint(a)).toBe(specFingerprint(b));
  });

  it('ignores list ordering so two equivalent specs pool together', () => {
    const a = sandbox({ packages: ['ripgrep', 'jq'] });
    const b = sandbox({ packages: ['jq', 'ripgrep'] });
    expect(specFingerprint(a)).toBe(specFingerprint(b));
  });

  it('ignores lifecycle, which is a scheduling fact rather than a build input', () => {
    expect(specFingerprint(sandbox({ lifecycle: 'invocation' })))
      .toBe(specFingerprint(sandbox({ lifecycle: 'conversation' })));
  });

  it('changes when anything that affects the built image changes', () => {
    const base = specFingerprint(sandbox());
    expect(specFingerprint(sandbox({ languages: ['python312'] }))).not.toBe(base);
    expect(specFingerprint(sandbox({ packages: ['jq'] }))).not.toBe(base);
    expect(specFingerprint(sandbox({ egress: false }))).not.toBe(base);
    expect(specFingerprint(sandbox({ env: { CI: 'true' } }))).not.toBe(base);
  });
});

describe('poolable', () => {
  it('pools ordinary sandboxes', () => {
    expect(poolable(sandbox())).toBe(true);
  });

  it('never pools a clean-room sandbox or a real machine', () => {
    expect(poolable(sandbox({ cleanRoom: true }))).toBe(false);
    expect(poolable({ kind: 'machine', lifecycle: 'persistent' })).toBe(false);
  });
});
