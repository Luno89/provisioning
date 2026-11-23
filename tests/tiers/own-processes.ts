import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { afterAll } from 'vitest';

interface Program { pid: number; parent: number; state: string; command: string }

const read = (pid: number): Program[] => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const [state = '', parent = '0'] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return [{ pid, parent: Number(parent), state, command }];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') return [];
    throw err;
  }
};

export function liveDescendants(root: number, programs: readonly Program[]): Program[] {
  const found: Program[] = [];
  const parents = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const program of programs) {
      if (!parents.has(program.parent) || parents.has(program.pid)) continue;
      parents.add(program.pid);
      found.push(program);
      grew = true;
    }
  }
  return found.filter((program) => program.state !== 'Z');
}

const listeningInodes = (port: number): Set<string> => {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [, local = '', , state = ''] = fields;
      if (state === '0A' && parseInt(local.slice(local.lastIndexOf(':') + 1), 16) === port) inodes.add(fields[9] ?? '');
    }
  }
  return inodes;
};

const socketsOf = (pid: number): string[] => {
  try {
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        return target.startsWith('socket:[') ? [target.slice(8, -1)] : [];
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') return [];
    throw err;
  }
};

export function listenerIsOwn(port: number, root: number): boolean {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return false;
  const programs = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => read(Number(name)));
  return [root, ...liveDescendants(root, programs).map((program) => program.pid)].some((pid) => socketsOf(pid).some((inode) => inodes.has(inode)));
}

const killed = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
};

afterAll(() => {
  const programs = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => read(Number(name)));
  const left = liveDescendants(process.pid, programs);
  if (left.length === 0) return;
  for (const program of left) killed(program.pid);
  throw new Error(`this file left ${left.length} program${left.length === 1 ? '' : 's'} of its own running after its last afterAll, now killed: ${left.map((program) => `${program.pid} ${program.command}`).join(', ')}`);
}, 0);
