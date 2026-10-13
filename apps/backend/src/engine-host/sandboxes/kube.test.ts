import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createKubeRunner } from './kube.js';

let binDir: string;

beforeEach(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-kubectl-'));
  await fs.writeFile(path.join(binDir, 'kubectl'), '#!/bin/sh\necho "started $*"\nexec sleep "$1"\n', { mode: 0o755 });
});

afterEach(async () => {
  await fs.rm(binDir, { recursive: true, force: true });
});

describe('running kubectl', () => {
  it('still stops a call at its limit by default, and says it was the limit', async () => {
    const result = await createKubeRunner({ binDir })(['5'], undefined, 200);
    expect(result.stopped).toBe('timeout');
    expect(result.stdout).toBe('started 5\n');
  });

  it('lets an untimed call run past any limit until it ends', async () => {
    const result = await createKubeRunner({ binDir })(['0.4'], undefined, 100, { untimed: true });
    expect(result).toEqual({ stdout: 'started 0.4\n', stderr: '', exitCode: 0 });
  });

  it('on a stop, runs the clean-up first and only then lets go of kubectl', async () => {
    const order: string[] = [];
    const stop = new AbortController();
    const running = createKubeRunner({ binDir })(['30'], undefined, undefined, {
      untimed: true,
      signal: stop.signal,
      onStop: async (why) => { order.push(`clean-up for ${why}`); await new Promise((resolve) => setTimeout(resolve, 100)); order.push('cleaned'); },
    });
    setTimeout(() => stop.abort(), 100);
    const result = await running;
    order.push('kubectl ended');

    expect(result.stopped).toBe('cancelled');
    expect(order).toEqual(['clean-up for cancelled', 'cleaned', 'kubectl ended']);
  });
});
