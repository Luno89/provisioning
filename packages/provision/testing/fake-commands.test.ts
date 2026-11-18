import { describe, expect, it } from 'vitest';
import type { Command } from '../src/commands.js';
import { CONTRACT, commandRunnerContract } from './command-runner-contract.js';
import { fakeCommands, type Answer } from './fake-commands.js';

const same = (a: Command, b: Command): boolean => a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);

const asShWould = (command: Command): Answer | undefined => {
  if (same(command, CONTRACT.bothStreams)) return { stdout: 'one\ntwo\n', stderr: 'three\n' };
  if (same(command, CONTRACT.unfinishedLine)) return { stdout: 'partial' };
  if (same(command, CONTRACT.failing)) return { stdout: 'before\n', code: 3 };
  if (same(command, CONTRACT.redrawn)) return { stdout: '10%\r20%\rdone\n' };
  if (same(command, CONTRACT.echoed)) return { stdout: command.stdin ?? '' };
  if (same(command, CONTRACT.withEnv)) return { stdout: `${command.env?.['KOALA_PROVISION_SAID'] ?? ''}\n` };
  return undefined;
};

commandRunnerContract('fakeCommands', () => fakeCommands(asShWould));

describe('fakeCommands', () => {
  it('keeps every command it was asked to run, in order', async () => {
    const commands = fakeCommands(() => ({}));
    await commands.run({ command: 'k3s', args: ['--version'] }, { line: () => undefined });
    await commands.run({ command: 'systemctl', args: ['start', 'k3s'], sudo: true }, { line: () => undefined });
    expect(commands.ran).toEqual([{ command: 'k3s', args: ['--version'] }, { command: 'systemctl', args: ['start', 'k3s'], sudo: true }]);
  });

  it('ends a command the way it was told, by a signal as well as by a code', async () => {
    const err: unknown = await fakeCommands(() => ({ signal: 'SIGKILL' })).run({ command: 'sleep' }, { line: () => undefined }).then(() => undefined, (thrown: unknown) => thrown);
    expect(err).toMatchObject({ ending: { signal: 'SIGKILL' } });
  });
});

describe('a command under sudo that failed', () => {
  it('is named without the values of its environment, which may be secrets', async () => {
    const err: unknown = await fakeCommands(() => ({ code: 1 })).run({ command: 'k3s', args: ['server'], sudo: true, env: { K3S_TOKEN: 'not-to-be-shown' } }, { line: () => undefined }).then(() => undefined, (thrown: unknown) => thrown);
    expect(err).toMatchObject({ message: 'sudo -- k3s server exited with 1', argv: ['sudo', '--', 'k3s', 'server'] });
  });
});
