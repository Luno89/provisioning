import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HANDED_PORTS = { first: 20000, last: 29999 } as const;

const claims = join(tmpdir(), 'koala-ports');
const span = HANDED_PORTS.last - HANDED_PORTS.first + 1;
let next = HANDED_PORTS.first + ((process.pid * 7919) % span);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function claim(port: number, retaking = false): boolean {
  mkdirSync(claims, { recursive: true });
  const file = join(claims, String(port));
  try {
    const fd = openSync(file, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || retaking) return false;
    const holder = Number(readFileSync(file, 'utf8'));
    if (holder === process.pid || (Number.isInteger(holder) && holder > 0 && alive(holder))) return false;
    unlinkSync(file);
    return claim(port, true);
  }
}

const bindable = (port: number): Promise<boolean> => new Promise((done) => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
});

export async function portToHandOn(): Promise<number> {
  for (let tried = 0; tried < span; tried += 1) {
    const port = next;
    next = next >= HANDED_PORTS.last ? HANDED_PORTS.first : next + 1;
    if (claim(port) && await bindable(port)) return port;
  }
  throw new Error(`no port between ${HANDED_PORTS.first} and ${HANDED_PORTS.last} is free to hand to another process`);
}
