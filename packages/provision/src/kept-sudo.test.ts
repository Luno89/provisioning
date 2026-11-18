import { describe, expect, it } from 'vitest';
import { fakeCommands } from '../testing/fake-commands.js';
import type { Command } from './commands.js';
import { keptSudo, SUDO_REFRESH_MS, type Every } from './kept-sudo.js';

const silent = { line: () => undefined };

function clock() {
  const ticks: { refresh: () => void; ms: number; stopped: boolean }[] = [];
  const every: Every = (refresh, ms) => {
    const tick = { refresh, ms, stopped: false };
    ticks.push(tick);
    return { stop: () => { tick.stopped = true; } };
  };
  return { ticks, every, tick: async () => { for (const tick of ticks) if (!tick.stopped) tick.refresh(); await new Promise((done) => setImmediate(done)); } };
}

const argv = (command: Command) => [command.command, ...(command.args ?? [])].join(' ');

describe('keptSudo', () => {
  it('asks for the password once, before the first command that needs it, and never for one that does not', async () => {
    const runner = fakeCommands(() => ({}));
    const time = clock();
    const sudo = keptSudo(runner, { every: time.every, lost: () => undefined });
    await sudo.run({ command: 'tailscale', args: ['ip', '-4'] }, silent);
    expect(runner.ran.map(argv)).toEqual(['tailscale ip -4']);
    await sudo.run({ command: 'tailscale', args: ['up'], sudo: true }, silent);
    await sudo.run({ command: 'install', args: ['-m', '755', 'k3s', '/usr/local/bin/k3s'], sudo: true }, silent);
    expect(runner.ran.map(argv)).toEqual(['tailscale ip -4', expect.stringMatching(/^sudo -v -p /) as unknown, 'tailscale up', 'install -m 755 k3s /usr/local/bin/k3s']);
    expect(runner.ran.filter((command) => command.command === 'sudo')).toHaveLength(1);
    sudo.end();
  });

  it('keeps the password fresh without asking again until the work ends, then stops', async () => {
    const runner = fakeCommands(() => ({}));
    const time = clock();
    const sudo = keptSudo(runner, { every: time.every, lost: () => undefined });
    await sudo.run({ command: 'true', sudo: true }, silent);
    expect(time.ticks.map((tick) => tick.ms)).toEqual([SUDO_REFRESH_MS]);
    await time.tick();
    await time.tick();
    expect(runner.ran.map(argv).filter((line) => line.startsWith('sudo -n -v'))).toHaveLength(2);
    sudo.end();
    await time.tick();
    expect(runner.ran.map(argv).filter((line) => line.startsWith('sudo -n -v'))).toHaveLength(2);
    expect(time.ticks[0]!.stopped).toBe(true);
  });

  it('says so when sudo no longer keeps the password, so asking again is no surprise', async () => {
    const runner = fakeCommands((command) => (command.args?.[0] === '-n' ? { code: 1, stderr: 'sudo: a password is required' } : {}));
    const time = clock();
    const lost: string[] = [];
    const sudo = keptSudo(runner, { every: time.every, lost: (why) => { lost.push(why); } });
    await sudo.run({ command: 'true', sudo: true }, silent);
    await time.tick();
    expect(lost).toEqual([expect.stringContaining('sudo -n -v exited with 1') as unknown]);
    sudo.end();
  });

  it('fails the command, saying why, when the password is refused, and does not ask again', async () => {
    const runner = fakeCommands((command) => (command.command === 'sudo' ? { code: 1, stderr: 'sudo: 3 incorrect password attempts' } : {}));
    const sudo = keptSudo(runner, { every: clock().every, lost: () => undefined });
    await expect(sudo.run({ command: 'tailscale', args: ['up'], sudo: true }, silent)).rejects.toThrow(/sudo did not let this run as root: .*sudo -v .* exited with 1/);
    await expect(sudo.run({ command: 'k3s', sudo: true }, silent)).rejects.toThrow(/sudo did not let this run as root/);
    expect(runner.ran.map(argv).filter((line) => line.startsWith('sudo'))).toHaveLength(1);
    expect(runner.ran.map(argv)).not.toContain('tailscale up');
    sudo.end();
  });
});
