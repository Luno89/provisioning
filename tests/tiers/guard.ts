import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import net from 'node:net';
import { afterAll } from 'vitest';

export interface Target { path?: string; host: string; port?: number }

export interface Rules {
  layer: string;
  advice: string;
  refusesProgram: (program: string) => boolean;
  refusesConnection: (target: Target) => boolean;
  refusesListening: boolean;
}

export function targetOf(args: unknown[]): Target {
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: string; host?: string; port?: number | string };
    return { ...(options.path !== undefined ? { path: options.path } : {}), host: options.host ?? 'localhost', ...(options.port !== undefined ? { port: Number(options.port) } : {}) };
  }
  if (typeof first === 'string' && second === undefined) return { path: first, host: 'localhost' };
  return { host: typeof second === 'string' ? second : 'localhost', port: Number(first) };
}

export const where = (target: Target): string => target.path ?? `${target.host}:${target.port ?? '?'}`;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

export function programOf(command: unknown, args: unknown): string {
  const first = String(command).trim().split(/\s+/)[0] ?? '';
  const name = basename(first);
  if (!SHELLS.has(name) || !Array.isArray(args)) return name;
  const script = args[args.indexOf('-c') + 1];
  return args.includes('-c') && typeof script === 'string' ? programOf(script, undefined) : name;
}

const answeredByMsw = (socket: object): boolean => Object.getOwnPropertySymbols(socket).some((symbol) => symbol.description === 'kPatched');

export function guardLayer(rules: Rules): void {
  const refused: string[] = [];
  const refusal = (what: string): Error => {
    refused.push(what);
    return new Error(`a ${rules.layer} test ${what}; ${rules.advice}`);
  };

  afterAll(() => {
    if (refused.length > 0) throw new Error(`this file reached outside its layer (${[...new Set(refused)].slice(0, 3).join('; ')}); ${rules.advice}`);
  });

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = targetOf(args);
    if (answeredByMsw(this) || !rules.refusesConnection(target)) return Reflect.apply(realConnect, this, args) as net.Socket;
    throw refusal(`opened a connection to ${where(target)}`);
  } as never;

  const realListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function listen(this: net.Server, ...args: unknown[]): net.Server {
    if (!rules.refusesListening) return Reflect.apply(realListen, this, args) as net.Server;
    throw refusal(`listened on ${where(targetOf(args))}`);
  } as never;

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    const real = childProcess[name] as (...args: unknown[]) => unknown;
    (childProcess as unknown as Record<string, unknown>)[name] = (command: unknown, ...rest: unknown[]) => {
      if (rules.refusesProgram(programOf(command, rest[0]))) throw refusal(`started a process (${name} ${String(command)})`);
      return real(command, ...rest);
    };
  }

  syncBuiltinESMExports();
}
