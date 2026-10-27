import { describe, expect, it } from 'vitest';
import { pushCommands } from './git-pack.js';
import { mayPushRef, machineBranch, machineFolder } from './machine-branches.js';

const pkt = (line: string): string => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);

describe('reading what a push changes', () => {
  it('reads every ref a push updates, up to the flush, ignoring the pack after it', () => {
    const body = Buffer.concat([
      Buffer.from(pkt(`${ZERO} ${A} refs/heads/machine/dev-1/run-1\0report-status side-band-64k\n`)),
      Buffer.from(pkt(`${A} ${ZERO} refs/heads/old\n`)),
      Buffer.from('0000PACK\u0000\u0000\u0000\u0002'),
    ]);
    expect(pushCommands(body)).toEqual({ ok: true, updates: [
      { old: ZERO, next: A, ref: 'refs/heads/machine/dev-1/run-1' },
      { old: A, next: ZERO, ref: 'refs/heads/old' },
    ], end: body.indexOf('PACK') });
  });

  it('refuses a body that is not git\'s push commands', () => {
    expect(pushCommands(Buffer.from('PACK')).ok).toBe(false);
    expect(pushCommands(Buffer.from('0000')).ok).toBe(false);
    expect(pushCommands(Buffer.from('00ffshort')).ok).toBe(false);
  });
});

describe('the branches a machine may push', () => {
  it('names a step\'s branch under the machine\'s own, safe for git', () => {
    expect(machineBranch('dev-1', 'grove-run-t~2026:executor-1:work:1')).toBe('machine/dev-1/grove-run-t-2026-executor-1-work-1');
  });

  it('lets a machine push only its own branches', () => {
    expect(mayPushRef('dev-1', 'refs/heads/machine/dev-1/run-1')).toBe(true);
    expect(mayPushRef('dev-1', 'refs/heads/main')).toBe(false);
    expect(mayPushRef('dev-1', 'refs/heads/machine/dev-2/run-1')).toBe(false);
    expect(mayPushRef('dev-1', 'refs/heads/leaf/l1')).toBe(false);
  });

  it('keeps each workspace folder in its own place on the machine', () => {
    expect(machineFolder('tree-t1', '/work/trees/l1')).toBe('tree-t1/trees/l1');
    expect(machineFolder('tree-t1', '/work/repo')).toBe('tree-t1/repo');
    expect(machineFolder('tree-t1', '/work/../etc')).toBe('tree-t1/etc');
  });
});
