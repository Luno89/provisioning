import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { removeThrowaway, sweepThrowaways, throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';

const run = promisify(execFile);
const IMAGE = 'alpine:3.20';
const made: string[] = [];
afterEach(async () => { for (const name of made.splice(0).reverse()) if (await alive(name)) await removeThrowaway(name); });

const alive = async (name: string) => (await run('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])).stdout.trim() === name;
const named = (what: string) => { const name = `koala-throwaway-${what}-${randomUUID().slice(0, 8)}`; made.push(name); return name; };
const settled = (sweep: Promise<string[]>) => sweep.then((removed) => ({ removed }), (failure: Error) => ({ failed: failure.message }));
const checkout = () =>`/koala-checkout-${randomUUID().slice(0, 8)}`;

async function deadPid(): Promise<number> {
  const dead = spawn('true');
  await new Promise((done) => dead.once('exit', done));
  return dead.pid!;
}

async function slowToTearDown(target: string): Promise<() => Promise<void>> {
  const pid = (await run('docker', ['inspect', '-f', '{{.State.Pid}}', target])).stdout.trim();
  const holder = named('holder');
  await run('docker', ['run', '-d', '--name', holder, ...throwawayLabel(), '--privileged', '--pid=host', IMAGE, 'sh', '-c', `nsenter -t ${pid} -p sleep infinity & echo $! > /held; wait`]);
  const inside = (script: string) => run('docker', ['exec', holder, 'sh', '-c', script]);
  const entered = `h=$(cat /held) && c=$(cat /proc/$h/task/$h/children | tr -d ' ') && [ -n "$c" ] && [ "$(readlink /proc/$c/ns/pid)" = "$(readlink /proc/${pid}/ns/pid)" ]`;
  while (await inside(entered).then(() => false, () => true)) {
    for (const name of [target, holder]) {
      if ((await run('docker', ['inspect', '-f', '{{.State.Running}}', name])).stdout.trim() !== 'true') throw new Error(`${name} stopped before the holder entered ${target}'s processes: ${(await run('docker', ['logs', holder])).stderr}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  await inside('kill -STOP $(cat /held)');
  return async () => { await inside('kill -CONT $(cat /held)'); };
}

describe('throwaway containers a test run leaves when it is killed', () => {
  it('are removed by the next run once the process that made them is gone, and one whose maker still runs is kept', async () => {
    const orphan = named('orphan');
    const kept = named('kept');
    await run('docker', ['create', '--name', orphan, ...throwawayLabel(await deadPid()), IMAGE, 'true']);
    await run('docker', ['create', '--name', kept, ...throwawayLabel(), IMAGE, 'true']);
    await sweepThrowaways();
    expect(await alive(orphan)).toBe(false);
    expect(await alive(kept)).toBe(true);
  });

  it('are swept by two checkouts side by side, each removing only the orphans its own runs made', async () => {
    const first = checkout();
    const second = checkout();
    const ofFirst = named('of-first');
    const ofSecond = named('of-second');
    await run('docker', ['run', '-d', '--name', ofFirst, ...throwawayLabel(await deadPid(), first), IMAGE, 'sleep', 'infinity']);
    await run('docker', ['create', '--name', ofSecond, ...throwawayLabel(await deadPid(), second), IMAGE, 'true']);
    const release = await slowToTearDown(ofFirst);
    const firstSweep = settled(sweepThrowaways(first));
    const secondSweep = await settled(sweepThrowaways(second));
    await release();
    expect([await firstSweep, secondSweep]).toEqual([{ removed: [ofFirst] }, { removed: [ofSecond] }]);
    expect(await alive(ofFirst)).toBe(false);
    expect(await alive(ofSecond)).toBe(false);
  });
});

describe('removing a throwaway container', () => {
  it('waits for a container whose teardown outlasts the ten seconds Docker gives a kill, and then removes it', async () => {
    const outlasting = named('outlasting');
    const beside = named('beside');
    for (const name of [outlasting, beside]) await run('docker', ['run', '-d', '--name', name, ...throwawayLabel(), IMAGE, 'sleep', 'infinity']);
    const releases = [await slowToTearDown(outlasting), await slowToTearDown(beside)];
    const removing = removeThrowaway(outlasting).then(() => 'removed', (failure: Error) => failure.message);
    await expect(run('docker', ['rm', '-f', beside])).rejects.toThrow(/could not kill container/);
    for (const release of releases) await release();
    expect(await removing).toBe('removed');
    expect(await alive(outlasting)).toBe(false);
  });
});
