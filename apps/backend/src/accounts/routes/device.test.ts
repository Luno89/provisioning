import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { deviceOf, deviceToken } from '../../platform/lib/auth.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { rootAuthOver } from '../../platform/testing/root-auth.js';
import type { AuthService } from '../services/AuthService.js';
import { devicesFor } from './device.js';
import { openRoutesOf } from '../../open-routes.js';

const KEY = 'test-secret';

function devices(authService = mock<AuthService>()) {
  const { auth } = rootAuthOver(memoryDatabase(), { open: openRoutesOf('root') });
  return { devices: devicesFor({ auth, sessionKey: KEY, authService }), authService };
}

const requestWith = (cookie?: string, body?: unknown) => ({ headers: cookie ? { cookie } : {}, body, ip: '198.51.100.4' }) as unknown as Request;

function remembered(res: ReturnType<typeof mock<Response>>): { name: string; token: string; options: { maxAge?: number; httpOnly?: boolean } } {
  const [name, token, options] = res.cookie.mock.calls[0] as unknown as [string, string, { maxAge?: number; httpOnly?: boolean }];
  return { name, token, options };
}

describe('the browsers an account has signed in on', () => {
  it('knows a browser by the device cookie it holds, and none without one or with one that is not ours', () => {
    const { devices: set } = devices();
    const token = deviceToken('ann@example.com', KEY, 'phone');
    expect(set.known(requestWith(`device=${token}`))).toEqual({ account: 'ann@example.com', id: 'phone' });
    expect(set.known(requestWith())).toBeUndefined();
    expect(set.known(requestWith(`device=${deviceToken('ann@example.com', 'another-key')}`))).toBeUndefined();
    expect(set.known(requestWith('device=garbage'))).toBeUndefined();
  });

  it('remembers a browser for a year under the account\'s lower-cased address', () => {
    const { devices: set } = devices();
    const res = mock<Response>();
    set.remember(requestWith(), res, ' Ann@Example.com ');
    const { name, token, options } = remembered(res);
    expect(name).toBe('device');
    expect(deviceOf(token, KEY)?.account).toBe('ann@example.com');
    expect(options).toMatchObject({ httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000 });
  });

  it('keeps the id of a browser that signs in again as the same account, and gives another account its own', () => {
    const { devices: set } = devices();
    const held = `device=${deviceToken('ann@example.com', KEY, 'phone')}`;
    const again = mock<Response>();
    set.remember(requestWith(held), again, 'ann@example.com');
    expect(deviceOf(remembered(again).token, KEY)?.id).toBe('phone');
    const other = mock<Response>();
    set.remember(requestWith(held), other, 'bo@example.com');
    expect(deviceOf(remembered(other).token, KEY)).toMatchObject({ account: 'bo@example.com' });
    expect(deviceOf(remembered(other).token, KEY)?.id).not.toBe('phone');
  });

  it('asks the auth service whether a risky change is proven, with the proof in the body, the browser and the address', async () => {
    const { devices: set, authService } = devices();
    const user = { id: 'ann', email: 'ann@example.com' } as Parameters<typeof set.confirmed>[1];
    authService.confirmProblem.mockResolvedValue({ status: 403, error: 'Enter your password to do this' });
    const held = `device=${deviceToken('ann@example.com', KEY, 'phone')}`;
    expect(await set.confirmed(requestWith(held, { password: 'the-password', code: ' 123456 ' }), user)).toEqual({ status: 403, error: 'Enter your password to do this' });
    expect(authService.confirmProblem).toHaveBeenCalledWith(user, { password: 'the-password', code: '123456' }, { account: 'ann@example.com', id: 'phone' }, '198.51.100.4');
  });
});
