import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { afterAll } from 'vitest';

export const RENAME = 'it belongs in the integration tier: name the file *.integration.test.ts';

const refused: string[] = [];

export function refusal(what: string): Error {
  refused.push(what);
  return new Error(`a unit test ${what}; ${RENAME}`);
}

afterAll(() => {
  if (refused.length > 0) throw new Error(`this file reached outside its process (${[...new Set(refused)].slice(0, 3).join('; ')}); ${RENAME}`);
});

const where = (args: unknown[]): string => {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: string; host?: string; port?: number };
    return options.path ?? `${options.host ?? 'localhost'}:${options.port ?? '?'}`;
  }
  if (typeof first === 'string' && second === undefined) return first;
  return `${typeof second === 'string' ? second : 'localhost'}:${String(first)}`;
};

net.Socket.prototype.connect = function connect(...args: unknown[]): never {
  throw refusal(`opened a connection to ${where(args)}`);
} as never;

net.Server.prototype.listen = function listen(...args: unknown[]): never {
  throw refusal(`listened on ${where(args)}`);
} as never;

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  (childProcess as unknown as Record<string, unknown>)[name] = (command: unknown) => {
    throw refusal(`started a process (${name} ${String(command)})`);
  };
}

syncBuiltinESMExports();
