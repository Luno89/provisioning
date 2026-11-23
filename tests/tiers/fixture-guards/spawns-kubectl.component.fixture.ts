import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('asks kubectl for its version', () => {
  expect(spawnSync('kubectl', ['version', '--client']).status).toBe(0);
});
