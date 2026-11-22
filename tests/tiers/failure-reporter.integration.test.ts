import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Failures } from '../lib/audits.js';
import { freshPlaces } from '../lib/fresh-places.js';
import { here } from '../lib/processes.js';

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const FIXTURE = join(import.meta.dirname, 'fixture-fail');
const aPlace = freshPlaces('failure-reporter-');

describe('the failures a tier records', () => {
  it('keep, for each file that failed, when and what each of its failing tests failed on', async () => {
    const file = join(aPlace(), 'failures.json');
    const ran = await here.run({ command: join(CHECKOUT, 'node_modules', '.bin', 'vitest'), args: ['run'], cwd: FIXTURE, env: { KOALA_GATE_FAILURES: file } });
    expect(ran.code).toBe(1);
    const failures = JSON.parse(readFileSync(file, 'utf8')) as Failures;
    expect(Object.keys(failures)).toEqual(['tests/tiers/fixture-fail/two.fails.ts']);
    const [failure] = failures['tests/tiers/fixture-fail/two.fails.ts'] ?? [];
    expect(Date.parse(failure?.at ?? '')).not.toBeNaN();
    expect(failure?.why).toBe('a run that fails > fails on what it expected: expected 2 to be 3 // Object.is equality');
  });
});
