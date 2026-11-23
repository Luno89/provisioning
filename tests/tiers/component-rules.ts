import { inject } from 'vitest';
import { guardLayer, type Target } from './guard.js';
import { listenerIsOwn } from './own-processes.js';

const REAL_THINGS = /^(kubectl|helm|docker|k3s|k3d|temporal.*)$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const mongoHosts = (): { host: string; port: number }[] => {
  const uri = (inject as (key: string) => unknown)('mongoUri');
  if (typeof uri !== 'string') return [];
  const hosts = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1] ?? '';
  return hosts.split(',').map((one) => ({ host: one.slice(0, one.lastIndexOf(':')), port: Number(one.slice(one.lastIndexOf(':') + 1)) }));
};

const toRunsMongo = (target: Target): boolean =>
  mongoHosts().some((mongo) => mongo.port === target.port && (mongo.host === target.host || (LOOPBACK.has(mongo.host) && LOOPBACK.has(target.host))));

const toOwnListener = (target: Target): boolean =>
  target.port !== undefined && LOOPBACK.has(target.host) && listenerIsOwn(target.port, process.pid);

export function guardComponentLayer(layer: string): void {
  guardLayer({
    layer,
    advice: 'it belongs in the container layer: name the file *.container.test.ts',
    refusesProgram: (program) => REAL_THINGS.test(program),
    refusesConnection: (target) => target.path !== undefined || !(toRunsMongo(target) || toOwnListener(target)),
    refusesListening: false,
  });
}
