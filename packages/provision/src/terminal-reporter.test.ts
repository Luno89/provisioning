import { describe, expect, it } from 'vitest';
import { StepFailed } from './steps.js';
import { ROLLING_LINES, terminalReporter, type Terminal } from './terminal-reporter.js';

const screen = (tty: boolean, columns = 80): Terminal & { text: () => string } => {
  const written: string[] = [];
  return { isTTY: tty, columns, write: (text: string) => written.push(text), text: () => written.join('') };
};

const docker = { id: 'docker', title: 'Installing Docker' };
const k3s = { id: 'k3s', title: 'Installing k3s' };

describe('terminalReporter without a terminal', () => {
  it('numbers each step and prints every line it prints, plainly', async () => {
    const out = screen(false);
    const reporter = terminalReporter(out);
    await reporter.started(docker);
    reporter.line(docker, '\x1b[32mpulling\x1b[0m');
    reporter.line(docker, '   ');
    await reporter.done(docker);
    await reporter.started(k3s);
    await reporter.alreadyDone(k3s);
    expect(out.text()).toBe('\n[1] Installing Docker\n    pulling\n  done\n\n[2] Installing k3s\n  already done\n');
  });

  it('ends a failed step with why, without printing its lines twice', async () => {
    const out = screen(false);
    const reporter = terminalReporter(out);
    await reporter.started(k3s);
    reporter.line(k3s, 'downloading');
    await reporter.failed(k3s, new StepFailed('k3s', 'Installing k3s', 'the checksum did not match', ['downloading']));
    expect(out.text()).toBe('\n[1] Installing k3s\n    downloading\n  failed: the checksum did not match\n');
  });
});

describe('terminalReporter on a terminal', () => {
  it('shows a bold header and a dim rolling tail of the last lines, redrawn in place', async () => {
    const out = screen(true);
    const reporter = terminalReporter(out);
    await reporter.started(docker);
    expect(out.text()).toBe('\n\x1b[1m[1] Installing Docker\x1b[0m\n');
    reporter.line(docker, 'one');
    reporter.line(docker, 'two');
    expect(out.text()).toBe('\n\x1b[1m[1] Installing Docker\x1b[0m\n    \x1b[2mone\x1b[0m\n\x1b[1A\x1b[J    \x1b[2mone\x1b[0m\n    \x1b[2mtwo\x1b[0m\n');
  });

  it('keeps only the last lines on screen, cut to the terminal\'s width', async () => {
    const out = screen(true, 20);
    const reporter = terminalReporter(out);
    await reporter.started(docker);
    for (let line = 1; line <= ROLLING_LINES + 3; line += 1) reporter.line(docker, `line ${line} ${'x'.repeat(30)}`);
    const lastDraw = out.text().split('\x1b[J').at(-1)!;
    const shown = lastDraw.trimEnd().split('\n');
    expect(shown).toHaveLength(ROLLING_LINES);
    expect(shown[0]).toBe(`    \x1b[2mline 4 ${'x'.repeat(7)}\x1b[0m`);
  });

  it('clears the rolling tail when the step is done', async () => {
    const out = screen(true);
    const reporter = terminalReporter(out);
    await reporter.started(docker);
    reporter.line(docker, 'one');
    reporter.line(docker, 'two');
    await reporter.done(docker);
    expect(out.text().endsWith('\x1b[2A\x1b[J  done\n')).toBe(true);
  });

  it('prints the tail of what a failed step printed, which was only rolling past, then why', async () => {
    const out = screen(true);
    const reporter = terminalReporter(out);
    await reporter.started(k3s);
    reporter.line(k3s, 'downloading');
    await reporter.failed(k3s, new StepFailed('k3s', 'Installing k3s', 'the checksum did not match', ['downloading', 'sha256 mismatch']));
    expect(out.text().endsWith('\x1b[1A\x1b[J    downloading\n    sha256 mismatch\n  \x1b[31mfailed: the checksum did not match\x1b[0m\n')).toBe(true);
  });
});
