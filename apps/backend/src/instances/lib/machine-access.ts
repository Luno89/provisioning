import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { MACHINE_SCOPE, machineOfMetricsClient, METRICS_SCOPE } from '@koala/engine-core/root-client';
import { failureOf, stillDown } from '@koala/engine-core/failures';
import { ACCESS_JWT_TYP, SIGNING_ALG } from './oidc.js';

export interface MachineAccess {
  deviceId: string;
  until: number;
}

export interface MachineAccessExpected {
  issuer: string;
  audience: string;
  now: number;
}

export const NOT_A_MACHINE_TOKEN = 'the token is not a machine\'s';
export const NOT_A_METRICS_TOKEN = 'the token is not a machine\'s Prometheus\'s';

async function verified(token: string, keys: JWTVerifyGetKey, expected: MachineAccessExpected, what: string): Promise<JWTPayload | string> {
  try {
    return (await jwtVerify(token, keys, {
      issuer: expected.issuer, audience: expected.audience, algorithms: [SIGNING_ALG], typ: ACCESS_JWT_TYP, requiredClaims: ['exp', 'sub'], currentDate: new Date(expected.now),
    })).payload;
  } catch (err) {
    const failure = failureOf(err);
    if (failure.kind === 'temporary') throw Object.assign(stillDown(`${what} could not be checked just now: ${failure.reason}`), { status: 503 });
    return `${what} could not be checked: ${(err as Error).message}`;
  }
}

const accessOf = (payload: JWTPayload, deviceId: string): MachineAccess => ({ deviceId, until: (payload.exp ?? 0) * 1000 });

export async function checkMachineAccess(token: string, keys: JWTVerifyGetKey, expected: MachineAccessExpected): Promise<MachineAccess | string> {
  const payload = await verified(token, keys, expected, 'the machine\'s token');
  if (typeof payload === 'string') return payload;
  if (payload.scope !== MACHINE_SCOPE || typeof payload.sub !== 'string' || payload.client_id !== payload.sub || typeof payload.koala_key !== 'string') return NOT_A_MACHINE_TOKEN;
  return accessOf(payload, payload.sub);
}

export async function checkMetricsAccess(token: string, keys: JWTVerifyGetKey, expected: MachineAccessExpected): Promise<MachineAccess | string> {
  const payload = await verified(token, keys, expected, 'the metrics token');
  if (typeof payload === 'string') return payload;
  const deviceId = typeof payload.sub === 'string' && payload.client_id === payload.sub ? machineOfMetricsClient(payload.sub) : undefined;
  if (payload.scope !== METRICS_SCOPE || !deviceId) return NOT_A_METRICS_TOKEN;
  return accessOf(payload, deviceId);
}
