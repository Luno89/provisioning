import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AccessRevocations } from '../../platform/services/AccessRevocations.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { rootAuthOver } from '../../platform/testing/root-auth.js';
import type { AuthService } from '../services/AuthService.js';
import { devicesFor } from './device.js';
import { openRoutesOf } from '../../open-routes.js';

const ANN = { id: 'ann', email: 'ann@example.com' };
const BO = { id: 'bo', email: 'bo@example.com' };
const KEPT = { session: 'the-session-the-change-was-made-in', rootSid: 'its-session-at-root' };

function devices(authService = mock<AuthService>()) {
  const db = memoryDatabase();
  const revocations = new AccessRevocations();
  const { auth } = rootAuthOver(db, { open: openRoutesOf('root') });
  const signedIn = { getCookie: auth.getCookie, sessionCookieOptions: auth.sessionCookieOptions, keptSession: () => KEPT };
  return { devices: devicesFor({ auth: signedIn, store: db.accounts, authService, revocations }), authService, revocations, store: db.accounts };
}

const requestWith = (cookie?: string, body?: unknown) => ({ headers: cookie ? { cookie } : {}, body, ip: '198.51.100.4' }) as unknown as Request;

function remembered(res: ReturnType<typeof mock<Response>>): { name: string; secret: string; cookie: string; options: { maxAge?: number; httpOnly?: boolean } } {
  const [name, secret, options] = res.cookie.mock.calls[0] as unknown as [string, string, { maxAge?: number; httpOnly?: boolean }];
  return { name, secret, cookie: `${name}=${secret}`, options };
}

async function rememberedFor(set: ReturnType<typeof devices>['devices'], person: { id: string; email: string }, held?: string) {
  const res = mock<Response>();
  await set.remember(requestWith(held), res, person);
  return remembered(res);
}

describe('the browsers an account has signed in on', () => {
  it('knows a browser by the record its cookie names, and none without one or with one Koala never made', async () => {
    const { devices: set } = devices();
    const { cookie } = await rememberedFor(set, ANN);
    const known = await set.known(requestWith(cookie));
    expect(known?.account).toBe('ann@example.com');
    expect(known?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(await set.known(requestWith())).toBeUndefined();
    expect(await set.known(requestWith('device=garbage'))).toBeUndefined();
  });

  it('keeps no secret of the cookie in its record', async () => {
    const { devices: set, store } = devices();
    const { cookie, secret } = await rememberedFor(set, ANN);
    const known = await set.known(requestWith(cookie));
    expect(known?.id).not.toContain(secret);
    expect(JSON.stringify(await store.getRememberedBrowser(known!.id))).not.toContain(secret);
  });

  it('remembers a browser for a year under the account\'s lower-cased address', async () => {
    const { devices: set, store } = devices();
    const { name, cookie, options } = await rememberedFor(set, { id: 'ann', email: ' Ann@Example.com ' });
    expect(name).toBe('device');
    expect(options).toMatchObject({ httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000 });
    const known = await set.known(requestWith(cookie));
    expect(known?.account).toBe('ann@example.com');
    expect((await store.getRememberedBrowser(known!.id))?.ownerId).toBe('ann');
  });

  it('keeps the browser of one that signs in again as the same account, and gives another account its own', async () => {
    const { devices: set } = devices();
    const first = await rememberedFor(set, ANN);
    const again = await rememberedFor(set, ANN, first.cookie);
    expect(await set.known(requestWith(again.cookie))).toEqual(await set.known(requestWith(first.cookie)));
    const other = await rememberedFor(set, BO, first.cookie);
    expect((await set.known(requestWith(other.cookie)))?.account).toBe('bo@example.com');
    expect((await set.known(requestWith(other.cookie)))?.id).not.toBe((await set.known(requestWith(first.cookie)))?.id);
  });

  it('forgets every browser of a person whose access was revoked, but the one they kept, and no one else\'s', async () => {
    const { devices: set, revocations } = devices();
    const phone = await rememberedFor(set, ANN);
    const laptop = await rememberedFor(set, ANN);
    const bos = await rememberedFor(set, BO);
    const kept = await set.kept(requestWith(laptop.cookie));
    expect(kept).toEqual({ ...KEPT, browser: (await set.known(requestWith(laptop.cookie)))?.id });
    await revocations.revoked({ personId: 'ann', because: 'password-or-2fa', at: new Date().toISOString(), kept });
    expect(await set.known(requestWith(phone.cookie))).toBeUndefined();
    expect(await set.known(requestWith(laptop.cookie))).toBeDefined();
    expect(await set.known(requestWith(bos.cookie))).toBeDefined();
    await revocations.revoked({ personId: 'ann', because: 'account-removed', at: new Date().toISOString() });
    expect(await set.known(requestWith(laptop.cookie))).toBeUndefined();
    const again = await rememberedFor(set, ANN, laptop.cookie);
    expect(await set.known(requestWith(again.cookie))).toBeDefined();
  });

  it('asks the auth service whether a risky change is proven, with the proof in the body, the browser and the address', async () => {
    const { devices: set, authService } = devices();
    const user = { id: 'ann', email: 'ann@example.com' } as Parameters<typeof set.confirmed>[1];
    authService.confirmProblem.mockResolvedValue({ status: 403, error: 'Enter your password to do this' });
    const { cookie } = await rememberedFor(set, ANN);
    const browser = await set.known(requestWith(cookie));
    expect(await set.confirmed(requestWith(cookie, { password: 'the-password', code: ' 123456 ' }), user)).toEqual({ status: 403, error: 'Enter your password to do this' });
    expect(authService.confirmProblem).toHaveBeenCalledWith(user, { password: 'the-password', code: '123456' }, browser, '198.51.100.4');
  });
});
