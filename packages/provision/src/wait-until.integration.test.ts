import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localCommands } from './local-commands.js';
import { waiting, waitUntil } from './wait-until.js';

const runner = localCommands(process.env);
const quiet = { line: () => undefined };
const folders: string[] = [];
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'koala-provision-'));
  folders.push(made);
  return made;
};

afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

describe('waitUntil with real waits', () => {
  it('waits through real pauses until a real process has made what it waits for', async () => {
    const marker = join(folder(), 'ready');
    const making = runner.run({ command: 'sh', args: ['-c', `sleep 1; touch '${marker}'`] }, quiet);
    expect(await waitUntil('the marker', async () => (existsSync(marker) ? true : waiting(`${marker} is not there yet`)))).toBe(true);
    await making;
  });

  it('ends as soon as the process that would make it has ended without it', async () => {
    const marker = join(folder(), 'never');
    let ended: string | undefined;
    const making = runner.run({ command: 'sh', args: ['-c', 'sleep 1; echo the disk is full >&2; exit 1'] }, quiet).then(
      () => { ended = 'it finished without making the marker'; },
      (err: unknown) => { ended = (err as Error).message; },
    );
    await expect(waitUntil('the marker', async () => (existsSync(marker) ? true : waiting(`${marker} is not there yet`)), async () => ended)).rejects.toThrow(`the marker: sh -c 'sleep 1; echo the disk is full >&2; exit 1' exited with 1`);
    await making;
  });
});
