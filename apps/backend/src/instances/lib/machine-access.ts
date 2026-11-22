import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { MACHINE_SCOPE } from '@koala/engine-core/root-client';
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

export async function checkMachineAccess(token: string, keys: JWTVerifyGetKey, expected: MachineAccessExpected): Promise<MachineAccess | string> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: expected.issuer, audience: expected.audience, algorithms: [SIGNING_ALG], typ: ACCESS_JWT_TYP, requiredClaims: ['exp', 'sub'], currentDate: new Date(expected.now),
    }));
  } catch (err) {
    return `the machine's token could not be checked: ${(err as Error).message}`;
  }
  if (payload.scope !== MACHINE_SCOPE || typeof payload.sub !== 'string' || payload.client_id !== payload.sub || typeof payload.koala_key !== 'string') return NOT_A_MACHINE_TOKEN;
  return { deviceId: payload.sub, until: (payload.exp ?? 0) * 1000 };
}
