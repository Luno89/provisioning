import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evidenceOf } from './leaf-verify.js';
import { combineVerification } from './leaf-artifacts.js';

describe('a pass that was not earned', () => {
  it('does not count when the fallback suite ran and nothing was committed', () => {
    expect(evidenceOf('passed', { declaredCommand: false, changed: false })).toBe('unverified');
  });

  it('counts when the leaf actually changed something', () => {
    expect(evidenceOf('passed', { declaredCommand: false, changed: true })).toBe('passed');
  });

  it('counts when the LEAF chose the command, even with nothing committed', () => {
    expect(evidenceOf('passed', { declaredCommand: true, changed: false })).toBe('passed');
  });
});

describe('what must never be downgraded', () => {
  it('leaves a failure a failure, however little the leaf changed', () => {
    expect(evidenceOf('failed', { declaredCommand: false, changed: false })).toBe('failed');
    expect(evidenceOf('failed', { declaredCommand: true, changed: true })).toBe('failed');
  });

  it('leaves an already-unverified outcome alone', () => {
    expect(evidenceOf('unverified', { declaredCommand: false, changed: false })).toBe('unverified');
    expect(evidenceOf('unverified', { declaredCommand: true, changed: true })).toBe('unverified');
  });
});

describe('what the leaf ends up recording', () => {
  it('turns the observed leaf from verified into claimed', () => {
    const earned = evidenceOf('passed', { declaredCommand: false, changed: false });
    const combined = combineVerification(earned, 'none');
    expect(combined).toBe('unverified');
    expect(combined === 'passed').toBe(false);
  });

  it('still lets a leaf that committed work be verified', () => {
    const earned = evidenceOf('passed', { declaredCommand: false, changed: true });
    expect(combineVerification(earned, 'none')).toBe('passed');
  });

  it('does not let the downgrade rescue a declared artifact that is missing', () => {
    expect(combineVerification(evidenceOf('passed', { declaredCommand: false, changed: false }), 'missing')).toBe('failed');
  });
});

describe('where the rule is applied', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const activity = readFileSync(join(here, '../activities/ExecuteLeafActivity.ts'), 'utf8');

  it('feeds the earned outcome into the combination, not the raw one', () => {
    expect(activity).toMatch(/combineVerification\(earned, artifacts\.outcome\)/);
  });

  it('decides changed-ness from the push, which is the only durable record', () => {
    expect(activity).toMatch(/changed: Boolean\(pushedBranch\)/);
  });

  it('exempts a research leaf, whose findings never depended on a commit', () => {
    expect(activity).toMatch(/outputPath\s*\n?\s*\? verify\.outcome/);
  });

  it('is applied after the push, so changed-ness is known', () => {
    const push = activity.indexOf('const pushedBranch = await pushBack()');
    const rule = activity.indexOf('const earned = outputPath');
    expect(push).toBeGreaterThan(-1);
    expect(push).toBeLessThan(rule);
  });
});
