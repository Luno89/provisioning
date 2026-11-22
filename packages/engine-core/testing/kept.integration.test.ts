import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeStreams } from '../src/node-processes.js';
import { startKept } from './kept.js';

interface Seen { state: string; parent: number }

const seen = (pid: number): Seen | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const [state = '', parent = '0'] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state, parent: Number(parent) };
  } catch {
    return undefined;
  }
};

const said = (output: string, what: string): number | undefined => {
  const line = new RegExp(`^${what} (\\d+)$`, 'm').exec(output);
  return line ? Number(line[1]) : undefined;
};

describe('a test\'s program, kept', () => {
  it('ends when the test process that started it is killed, which no afterAll can answer', async () => {
    let output = '';
    const holder = nodeStreams.start({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), join(import.meta.dirname, 'kept.fixture-program.ts')] }, { heard: { stdout: (chunk) => { output += chunk; } } });
    let holderEnded = false;
    void holder.exited.then(() => { holderEnded = true; });
    while (said(output, 'program') === undefined || said(output, 'keeper') === undefined) {
      if (holderEnded) throw new Error(`the holder ended before it started its program: ${output}`);
      await new Promise((done) => setTimeout(done, 20));
    }
    const program = said(output, 'program')!;
    const keeper = said(output, 'keeper')!;
    holder.stop('SIGKILL');
    await holder.exited;
    for (let now = seen(program); now && now.state !== 'Z'; now = seen(program)) {
      expect(now.parent, `the program (${program}) outlived the test process that started it, with nothing left to end it`).toBe(keeper);
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(seen(program)?.state ?? 'gone').toMatch(/^(gone|Z)$/);
  });

  it('hands a signal on to its program and ends as the program ended', async () => {
    const sleeping = startKept({ command: 'sleep', args: ['600'], env: { PATH: process.env.PATH } });
    sleeping.stop('SIGTERM');
    expect(await sleeping.exited).toEqual({ code: 128, signal: 'SIGTERM' });
    expect(await startKept({ command: 'sh', args: ['-c', 'echo told; exit 3'], env: { PATH: process.env.PATH } }).ended).toMatchObject({ code: 3, stdout: 'told\n' });
  });
});
