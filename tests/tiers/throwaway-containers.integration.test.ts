import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepThrowaways, throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';

const run = promisify(execFile);
const made: string[] = [];
afterEach(async () => { for (const name of made.splice(0)) await run('docker', ['rm', '-f', name]).catch(() => undefined); });

const alive = async (name: string) => (await run('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])).stdout.trim() === name;

describe('throwaway containers a test run leaves when it is killed', () => {
  it('are removed by the next run once the process that made them is gone, and one whose maker still runs is kept', async () => {
    const dead = spawn('true');
    await new Promise((done) => dead.once('exit', done));
    const orphan = `koala-throwaway-check-${randomUUID().slice(0, 8)}`;
    const kept = `koala-throwaway-check-${randomUUID().slice(0, 8)}`;
    made.push(orphan, kept);
    await run('docker', ['create', '--name', orphan, ...throwawayLabel(dead.pid!), 'alpine:3.20', 'true']);
    await run('docker', ['create', '--name', kept, ...throwawayLabel(), 'alpine:3.20', 'true']);
    await sweepThrowaways();
    expect(await alive(orphan)).toBe(false);
    expect(await alive(kept)).toBe(true);
  });
});
