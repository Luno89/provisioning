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

describe('what ship leaves running', () => {
  it('outlives the terminal ship ran in hanging up, as npm run dev must after ship', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outliving-ship-'));
    dirs.push(dir);
    const heard = join(dir, 'heard');
    const child = `process.on('SIGHUP', () => { require('fs').writeFileSync(${JSON.stringify(heard)}, 'hung up'); process.exit(0); }); process.on('SIGTERM', () => process.exit(0)); console.log('listening'); setInterval(() => {}, 1 << 30);`;
    const ship = `import { openSync, readFileSync } from 'node:fs'; import { startOutlivingShip } from ${JSON.stringify(GATE_RUNS)}; const out = openSync(${JSON.stringify(join(dir, 'dev.log'))}, 'w'); const dev = startOutlivingShip(process.execPath, ['-e', ${JSON.stringify(child)}], ${JSON.stringify(dir)}, out); dev.unref(); const said = () => { if (readFileSync(${JSON.stringify(join(dir, 'dev.log'))}, 'utf8').includes('listening')) { console.log(dev.pid); } else setImmediate(said); }; said(); setInterval(() => {}, 1 << 30);`;
    const shipFile = join(dir, 'ship.mts');
    writeFileSync(shipFile, ship);
    const terminal = spawn(process.execPath, ['--import', 'tsx', shipFile], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const devPid = Number(await firstLine(terminal.stdout!));
    process.kill(-terminal.pid!, 'SIGHUP');
    await new Promise((done) => terminal.once('exit', done));
    const stillThere = (() => { try { process.kill(devPid, 0); return true; } catch { return false; } })();
    if (stillThere) process.kill(devPid, 'SIGTERM');
    await ended(devPid);
    expect({ stillThere, heard: (() => { try { return readFileSync(heard, 'utf8'); } catch { return 'nothing'; } })() }).toEqual({ stillThere: true, heard: 'nothing' });
  });
});
