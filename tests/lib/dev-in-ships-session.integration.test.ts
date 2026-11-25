import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const GATE_RUNS = resolve(import.meta.dirname, 'gate-runs.ts');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const firstLine = (stream: NodeJS.ReadableStream): Promise<string> => new Promise((done, fail) => {
  let said = '';
  const heard = (chunk: Buffer) => {
    said += String(chunk);
    const end = said.indexOf('\n');
    if (end < 0) return;
    stream.off('data', heard);
    done(said.slice(0, end));
  };
  stream.on('data', heard);
  stream.once('end', () => fail(new Error(`it ended before saying anything: ${said}`)));
});

const ended = (pid: number): Promise<void> => new Promise((done) => {
  const look = () => { try { process.kill(pid, 0); setImmediate(look); } catch { done(); } };
  look();
});

const sessionOf = (pid: number): string => readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[3]!;

describe('what ship leaves running', () => {
  it('starts npm run dev in ship\'s own session, so the join can ask on ship\'s terminal before it installs anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outliving-ship-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dev-stand-in', version: '1.0.0', scripts: { dev: `node -e "console.log('listening'); setInterval(() => {}, 1 << 30)"` } }));
    const ship = `import { openSync, readFileSync } from 'node:fs'; import { startInShipsSession } from ${JSON.stringify(GATE_RUNS)}; const out = openSync(${JSON.stringify(join(dir, 'dev.log'))}, 'w'); const dev = startInShipsSession('npm', ['run', 'dev'], ${JSON.stringify(dir)}, out); dev.unref(); const said = () => { if (readFileSync(${JSON.stringify(join(dir, 'dev.log'))}, 'utf8').includes('listening')) { console.log(dev.pid); } else setImmediate(said); }; said(); setInterval(() => {}, 1 << 30);`;
    const shipFile = join(dir, 'ship.mts');
    writeFileSync(shipFile, ship);
    const terminal = spawn(process.execPath, ['--import', 'tsx', shipFile], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const devPid = Number(await firstLine(terminal.stdout!));
    const sameSession = sessionOf(devPid) === sessionOf(terminal.pid!);
    process.kill(-terminal.pid!, 'SIGTERM');
    await new Promise((done) => terminal.once('exit', done));
    try { process.kill(devPid, 'SIGTERM'); } catch { }
    await ended(devPid);
    expect(sameSession).toBe(true);
  });
});
