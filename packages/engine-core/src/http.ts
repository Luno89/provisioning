import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';
import { Agent, setGlobalDispatcher } from 'undici';

export const CONNECT_MS = 10_000;

export interface DispatcherOptions {
  connectMs?: number | undefined;
  lookup?: LookupFunction | undefined;
  ca?: string | Buffer | undefined;
}

export function dependencyDispatcher(options: DispatcherOptions = {}): Agent {
  return new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: options.connectMs ?? CONNECT_MS, ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.ca ? { ca: options.ca } : {}) },
  });
}

const connectTimedOut = (ms: number): Error =>
  Object.assign(new Error(`it did not finish connecting within ${ms / 1000} s`), { code: 'ETIMEDOUT' });

function limitConnect(socket: Duplex, ms: number, connected: string): Duplex {
  const timer = setTimeout(() => socket.destroy(connectTimedOut(ms)), ms);
  timer.unref();
  const done = () => clearTimeout(timer);
  socket.once(connected, done);
  socket.once('close', done);
  return socket;
}

class ConnectLimitedHttp extends http.Agent {
  private readonly connectMs: number;

  constructor(connectMs: number) {
    super({ keepAlive: true });
    this.connectMs = connectMs;
  }

  override createConnection(...args: Parameters<http.Agent['createConnection']>): Duplex {
    return limitConnect(super.createConnection(...args) as Duplex, this.connectMs, 'connect');
  }
}

class ConnectLimitedHttps extends https.Agent {
  private readonly connectMs: number;

  constructor(connectMs: number) {
    super({ keepAlive: true });
    this.connectMs = connectMs;
  }

  override createConnection(...args: Parameters<https.Agent['createConnection']>): Duplex {
    return limitConnect(super.createConnection(...args) as Duplex, this.connectMs, 'secureConnect');
  }
}

export function connectLimitedAgents(connectMs = CONNECT_MS): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  return { httpAgent: new ConnectLimitedHttp(connectMs), httpsAgent: new ConnectLimitedHttps(connectMs) };
}

export interface ProcessHttp {
  dispatcher: Agent;
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
}

let processHttp: ProcessHttp | undefined;

export function useDependencyHttp(): ProcessHttp {
  if (processHttp) return processHttp;
  const dispatcher = dependencyDispatcher();
  setGlobalDispatcher(dispatcher);
  processHttp = { dispatcher, ...connectLimitedAgents() };
  return processHttp;
}

export const dependencyFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  globalThis.fetch(input, { ...init, dispatcher: useDependencyHttp().dispatcher } as unknown as RequestInit)) as typeof fetch;
