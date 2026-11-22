import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const ended = spawn('sleep', ['601'], { stdio: 'ignore' });
const endedOnItsWay = new Promise<void>((done) => { ended.once('exit', () => { done(); }); });

afterAll(async () => {
  ended.kill('SIGTERM');
  await endedOnItsWay;
});

describe('a file that leaves a program of its own running', () => {
  it('starts one it never ends', () => {
    const left = spawn('sleep', ['600'], { stdio: 'ignore' });
    expect(left.pid).toBeGreaterThan(0);
  });
});
