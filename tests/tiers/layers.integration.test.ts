import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshPlaces } from '../lib/fresh-places.js';
import { here } from '../lib/processes.js';

const FIXTURE = join(import.meta.dirname, 'fixture-layers');
const aPlace = freshPlaces('layers-');
const COMPONENT_KEY = 'tests/tiers/fixture-layers/slow.component.fixture.ts > a component workload > takes eleven seconds';

const run = (project: string, list: Record<string, number>) => {
  const file = join(aPlace(), 'slow.json');
  writeFileSync(file, JSON.stringify(list));
  return here.run({ command: resolve(import.meta.dirname, '../../node_modules/.bin/vitest'), args: ['run', '--project', project], cwd: FIXTURE, env: { KOALA_SLOW_LIST: file } });
};


describe('a test over its budget', () => {
  it('fails a component test that takes more than ten seconds', async () => {
    const ran = await run('component', {});
    expect(ran.code).toBe(1);
    expect(ran.stdout + ran.stderr).toContain(`${COMPONENT_KEY}: 11 s, over the 10 s a component test may take`);
  });

  it('passes once the test is on the slow list, and says it is known slow', async () => {
    const ran = await run('component', { [COMPONENT_KEY]: 1 });
    expect(ran.code).toBe(0);
    expect(ran.stdout + ran.stderr).toContain('known slow, on the list to be fixed');
  });

  it('fails a unit test that takes more than a second', async () => {
    const ran = await run('unit', {});
    expect(ran.code).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('over the 1 s a unit test may take');
  });

  it('names a listed test that ran within its budget, so the list can be pruned', async () => {
    const ran = await run('unit', { 'tests/tiers/fixture-layers/slow.unit.fixture.ts > a unit workload > takes a second and a half': 1, 'tests/tiers/fixture-layers/slow.unit.fixture.ts > a unit workload > gone': 1 });
    expect(ran.code).toBe(0);
    expect(ran.stdout + ran.stderr).toContain('slow.unit.fixture.ts > a unit workload > gone');
  });
});
