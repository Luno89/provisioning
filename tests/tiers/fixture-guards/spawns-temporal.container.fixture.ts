import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('starts a temporal server itself', () => {
  expect(spawnSync('temporal', ['server', 'start-dev']).status).toBe(0);
});
