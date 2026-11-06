import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from './tool-exec.js';
import type { ToolContract } from './tools.js';
import { shellDriver } from '../testing/shell-driver.js';

const ARGUMENTS_AS_RECEIVED = 'printf "%s\\0" {first} {rest}';

const tool = (command: string): ToolContract => ({
  name: 'show_arguments',
  description: 'Prints each argument it is given',
  binding: 'environment',
  command,
});

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'koala-command-tool-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const run = async (command: string, args: Record<string, unknown>) => {
  const driver = shellDriver(folder);
  const outcome = await executeTool({
    name: 'show_arguments',
    arguments: JSON.stringify(args),
    granted: ['show_arguments'],
    catalogue: [tool(command)],
    driver,
  });
  return { outcome, driver };
};

const argumentsOf = (output: string | undefined): string[] => (output ?? '').split('\0').slice(0, -1);

describe('a command tool run by a real shell', () => {
  it('hands each argument to the program whole and byte for byte, whatever it contains', async () => {
    const hostile = [
      "it's",
      '; touch semicolon',
      '`touch backtick`',
      '$(touch substitution)',
      'one\ntouch newline',
      '*',
      '$HOME',
      '"double" \\ back',
      '  spaced  ',
      '',
    ];

    const { outcome } = await run(ARGUMENTS_AS_RECEIVED, { first: hostile[0], rest: hostile.slice(1) });

    expect(outcome.ok).toBe(true);
    expect(argumentsOf(outcome.content)).toEqual(hostile);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('passes a number and a flag as the text they are', async () => {
    const { outcome } = await run(ARGUMENTS_AS_RECEIVED, { first: 20, rest: ['-n', true] });

    expect(argumentsOf(outcome.content)).toEqual(['20', '-n', 'true']);
  });

  it('runs nothing when an argument cannot be put on a command line', async () => {
    const { outcome, driver } = await run(ARGUMENTS_AS_RECEIVED, { first: { nested: true } });

    expect(outcome).toEqual({ ok: false, digest: 'first has to be text, a number, or a list of them', content: 'first has to be text, a number, or a list of them' });
    expect(driver.commands).toEqual([]);
  });

  it('reports a command that fails with what it wrote to stderr', async () => {
    const { outcome } = await run('ls {first}', { first: 'not-here' });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('not-here');
    expect(outcome.content).toMatch(/No such file or directory/);
  });

  it('runs the shell commands run_command is given as they are written', async () => {
    const driver = shellDriver(folder);
    const outcome = await executeTool({
      name: 'run_command',
      arguments: JSON.stringify({ command: 'printf made > made.txt && cat made.txt' }),
      granted: ['run_command'],
      catalogue: [{ name: 'run_command', description: 'Runs a command', binding: 'environment' }],
      driver,
    });

    expect(outcome).toEqual({ ok: true, digest: 'made', content: 'made' });
    expect(readdirSync(folder)).toEqual(['made.txt']);
  });
});
