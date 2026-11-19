import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryReporter } from '../testing/memory-reporter.js';
import { localCommands } from './local-commands.js';
import { freeAt, roomStep } from './room.js';
import { runSteps, StepFailed } from './steps.js';

const made: string[] = [];
afterEach(async () => { for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('the room where something writes, on this computer', () => {
  it('refuses a disk with less free than needed, naming the folder that holds it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koala-room-'));
    made.push(dir);
    await mkdir(join(dir, 'held'));
    await writeFile(join(dir, 'held', 'data'), Buffer.alloc(3 * 1024 * 1024));
    await writeFile(join(dir, 'small'), 'x');
    const step = await roomStep({ id: 'room', what: 'tests', path: dir, needs: (await freeAt(dir)) + 1024 ** 3 });
    const failure: unknown = await runSteps([step], { commands: localCommands(process.env) }, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as StepFailed).why).toMatch(new RegExp(`^only .+ is free in ${dir} and tests need .+; using it: ${join(dir, 'held')} \\(3\\.0 MB\\), ${join(dir, 'small')}`));
  });
});
