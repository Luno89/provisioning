import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const held = process.env.FIXTURE_HELD_IN!;

async function heldUntil(name: string): Promise<void> {
  while (!existsSync(join(held, name))) await new Promise((next) => setTimeout(next, 50));
}

afterAll(async () => {
  console.log('    still waiting for the fixture to be let go (it is held)');
  console.log('    still waiting for the fixture to be let go (it is held)');
  await heldUntil('after');
});

describe('a held run', () => {
  it('says a line and is held', async () => {
    console.log(`first line\n${process.env.FIXTURE_SAYS ?? 'the line it said last'}`);
    await heldUntil('test');
    expect(true).toBe(true);
  });
});
