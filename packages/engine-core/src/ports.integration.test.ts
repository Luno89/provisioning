import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDED_PORTS, portToHandOn } from '../testing/ports.js';

describe('a port to hand to another process', () => {
  it('is below the range the system picks outgoing ports from, never handed twice, and claimed for this process', async () => {
    const ports = await Promise.all(Array.from({ length: 20 }, () => portToHandOn()));
    expect(new Set(ports).size).toBe(20);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(HANDED_PORTS.first);
      expect(port).toBeLessThanOrEqual(HANDED_PORTS.last);
      expect(readFileSync(join(tmpdir(), 'koala-ports', String(port)), 'utf8')).toBe(String(process.pid));
    }
  });

  it('passes over a port something already listens on', async () => {
    const taken = await portToHandOn();
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(taken + 1, '127.0.0.1', done));
    try {
      expect(await portToHandOn()).not.toBe(taken + 1);
    } finally {
      holder.close();
    }
  });

  it('takes back a port claimed by a process that has ended, and leaves one a living process holds', async () => {
    const ended = spawn(process.execPath, ['-e', '']);
    await new Promise((done) => ended.once('exit', done));
    const living = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    try {
      const next = await portToHandOn();
      mkdirSync(join(tmpdir(), 'koala-ports'), { recursive: true });
      writeFileSync(join(tmpdir(), 'koala-ports', String(next + 1)), String(living.pid));
      writeFileSync(join(tmpdir(), 'koala-ports', String(next + 2)), String(ended.pid));
      expect(await portToHandOn()).toBe(next + 2);
    } finally {
      living.kill();
    }
  });
});
