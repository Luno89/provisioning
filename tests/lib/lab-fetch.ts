import { readFileSync } from 'node:fs';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const LOOPBACK = '127.0.0.1';

const toLoopback: LookupFunction = (_host, options, done) => {
  if (options.all) return done(null, [{ address: LOOPBACK, family: 4 }]);
  return done(null, LOOPBACK, 4);
};

export function labFetch(caFile: string): typeof fetch {
  const dispatcher = new Agent({ connect: { ca: readFileSync(caFile), lookup: toLoopback } });
  return ((input: string | URL, init?: RequestInit) => undiciFetch(input, { ...(init as object), dispatcher })) as unknown as typeof fetch;
}
