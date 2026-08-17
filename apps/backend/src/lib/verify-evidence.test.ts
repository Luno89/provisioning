import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evidenceOf } from './leaf-verify.js';
import { combineVerification } from './leaf-artifacts.js';

/**
 * Whether a passing verification is evidence about the leaf that ran it.
 *
 * ── THE OBSERVED FAILURE ──
 * A leaf titled "Configure Docker build and deployment for the MCP server" finished `verified: true`
 * with an EMPTY outputBranch — it committed nothing at all, while its summary described a Dockerfile
 * it had written. The repository never received one.
 *
 * `verifyCommand` falls back to `defaultVerifyCommand()` for any repo leaf, which runs the
 * repository's existing suite. That suite was green before the leaf started and still green after it
 * did nothing, so the leaf inherited a verified tick from work somebody else had done.
 *
 * All four leaves in that run carried the tick, including the two that changed nothing.
 */

describe('a pass that was not earned', () => {
  it('does not count when the fallback suite ran and nothing was committed', () => {
    // The exact case. Nothing this leaf did could have changed that result.
    expect(evidenceOf('passed', { declaredCommand: false, changed: false })).toBe('unverified');
  });

  it('counts when the leaf actually changed something', () => {
    expect(evidenceOf('passed', { declaredCommand: false, changed: true })).toBe('passed');
  });

  it('counts when the LEAF chose the command, even with nothing committed', () => {
    /**
     * The exemption is the point, not a loophole. A leaf whose job is to call an already-deployed
     * service commits nothing by design, and the command it named was chosen to check exactly that.
     * Only the fallback is untrustworthy, because nobody picked it with this leaf in mind.
     */
    expect(evidenceOf('passed', { declaredCommand: true, changed: false })).toBe('passed');
  });
});

describe('what must never be downgraded', () => {
  it('leaves a failure a failure, however little the leaf changed', () => {
    // A suite failing on an unchanged repository is still a broken repository. Softening that to
    // `unverified` would hide it behind a leaf that succeeds on its claim.
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
    /**
     * End to end through the same combination the activity uses. The leaf still SUCCEEDS — most
     * work is not test-shaped and an unverified success is a normal outcome — it just stops
     * claiming something checked it.
     */
    const earned = evidenceOf('passed', { declaredCommand: false, changed: false });
    const combined = combineVerification(earned, 'none');
    expect(combined).toBe('unverified');
    expect(combined === 'passed').toBe(false); // this is what is stored as `verified`
  });

  it('still lets a leaf that committed work be verified', () => {
    const earned = evidenceOf('passed', { declaredCommand: false, changed: true });
    expect(combineVerification(earned, 'none')).toBe('passed');
  });

  it('does not let the downgrade rescue a declared artifact that is missing', () => {
    // `missing` outranks everything: a leaf that promised a file and produced none has failed,
    // whether or not it committed anything.
    expect(combineVerification(evidenceOf('passed', { declaredCommand: false, changed: false }), 'missing')).toBe('failed');
  });
});

describe('where the rule is applied', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const activity = readFileSync(join(here, '../activities/ExecuteLeafActivity.ts'), 'utf8');

  it('feeds the earned outcome into the combination, not the raw one', () => {
    // Computing it and then combining `verify.outcome` anyway would be a silent no-op.
    expect(activity).toMatch(/combineVerification\(earned, artifacts\.outcome\)/);
  });

  it('decides changed-ness from the push, which is the only durable record', () => {
    // A file left in a destroyed sandbox is not a change. `pushedBranch` is set only when a commit
    // actually reached the repository.
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
