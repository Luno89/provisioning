import { describe, it, expect, vi } from 'vitest';
import { WorkbenchService } from './WorkbenchService.js';

const fake = () => {
  const execs: { id: string; command: string; positional: string[] }[] = [];
  const written: { id: string; path: string; content: string }[] = [];
  return {
    execs,
    written,
    service: {
      create: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      reapStale: vi.fn(async () => ['old-1']),
      writeFile: vi.fn(async (id: string, path: string, content: string) => { written.push({ id, path, content }); }),
      exec: vi.fn(async (id: string, command: string, _ms?: number, positional: string[] = []) => {
        execs.push({ id, command, positional });
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
      }),
    } as any,
  };
};

describe('opening a session', () => {
  it('applies the seed, so the window shows the world the agent would wake up in', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    const { sessionId } = await wb.open('u1', { seed: [{ path: 'data.txt', content: 'hello' }] });

    expect(w.service.create).toHaveBeenCalled();
    expect(w.written).toEqual([{ id: sessionId, path: 'data.txt', content: 'hello' }]);
  });
});

describe('running commands', () => {
  it('never interpolates the command into the shell string', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    const { sessionId } = await wb.open('u1');
    await wb.exec('u1', sessionId, 'grep -q "it\'s" out.txt; rm -rf /');

    const run = w.execs.find((e) => !e.command.startsWith('rm -rf'))!;
    expect(run.command).toBe('sh -c "$0"');
    expect(run.positional).toEqual(['grep -q "it\'s" out.txt; rm -rf /']);
  });

  it('refuses a session belonging to someone else', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    const { sessionId } = await wb.open('u1');
    await expect(wb.exec('u2', sessionId, 'ls')).rejects.toThrow(/No such workbench session/);
  });

  it('refuses a session that was already closed', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    const { sessionId } = await wb.open('u1');
    await wb.close('u1', sessionId);
    await expect(wb.exec('u1', sessionId, 'ls')).rejects.toThrow(/No such workbench session/);
  });
});

describe('reset', () => {
  it('wipes and re-seeds, so iteration is not tested against its own debris', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    const { sessionId } = await wb.open('u1', { seed: [{ path: 'a.txt', content: '1' }] });
    await wb.reset('u1', sessionId);

    expect(w.execs.some((e) => e.command.startsWith('rm -rf'))).toBe(true);
    expect(w.written.filter((f) => f.path === 'a.txt')).toHaveLength(2);
  });

  it('adopts a new seed when the task changes', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    const { sessionId } = await wb.open('u1', { seed: [{ path: 'a.txt', content: '1' }] });
    await wb.reset('u1', sessionId, [{ path: 'b.txt', content: '2' }]);

    expect(w.written.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('not leaking pods', () => {
  it('reaps a session nobody has touched', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    const { sessionId } = await wb.open('u1');

    expect(await wb.reapIdle(Date.now() + 60 * 60_000)).toEqual([sessionId]);
    expect(w.service.destroy).toHaveBeenCalledWith(sessionId);
    await expect(wb.exec('u1', sessionId, 'ls')).rejects.toThrow();
  });

  it('leaves a session that was just used', async () => {
    const w = fake();
    const wb = new WorkbenchService(w.service);
    await wb.open('u1');
    expect(await wb.reapIdle()).toEqual([]);
  });

  it('asks the cluster about orphans, not its own memory', async () => {
    const w = fake();
    expect(await new WorkbenchService(w.service).sweepOrphans()).toEqual(['old-1']);
    expect(w.service.reapStale).toHaveBeenCalled();
  });
});
