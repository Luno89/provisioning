import { describe, expect, it } from 'vitest';
import express from 'express';
import { memoryDatabase } from '../testing/memory-database.js';
import { serveInProcess } from '../../instances/testing/serve-in-process.js';
import { arrivedOverHttps } from '../lib/auth.js';
import { BROWSER_SESSION_SECONDS, type BrowserPerson } from '../lib/browser-session.js';
import { BrowserSessions } from './BrowserSessions.js';

const person = (sub: string, rootSid = `root-of-${sub}`): BrowserPerson => ({
  sub, email: `${sub}@example.com`, claims: [{ role: 'person' }], sessionAt: 1, accessExp: 2, rootSid, tokens: { access: 'sealed-access', refresh: 'sealed-refresh', id: 'sealed-id' },
});

function world() {
  const db = memoryDatabase();
  const sessions = new BrowserSessions({ store: db.platform, secret: 'browser-sessions-key', securedFor: (req) => arrivedOverHttps(req.headers['x-forwarded-proto'], false) });
  const ended: string[] = [];
  sessions.onEnd((sid) => ended.push(sid));
  const app = express();
  app.use(sessions.handle);
  app.post('/sign-in/:sub', (req, res, next) => { sessions.hold(req, person(String(req.params.sub))).then(() => res.json({ sid: req.sessionID }), next); });
  app.get('/me', (req, res) => { res.json({ sub: req.session.person?.sub ?? null }); });
  app.post('/root-sign-in/:sub', (req, res, next) => { sessions.hold(req, { ...person(String(req.params.sub), `root-${String(req.params.sub)}`), sessionAt: 5 }).then(() => res.json({ sid: req.sessionID }), next); });
  app.get('/account', (req, res) => { res.json({ account: req.session.person?.sub ?? null, at: req.session.person?.sessionAt ?? null }); });
  app.post('/sign-out', (req, res, next) => { sessions.end(req).then(() => res.json({}), next); });
  const ask = async (method: string, path: string, cookie?: string, https = false) => {
    const answer = await serveInProcess(app, new Request(`http://koala.test${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(https ? { 'x-forwarded-proto': 'https' } : {}) } }));
    const set = answer.headers.getSetCookie()[0];
    return { status: answer.status, body: await answer.json() as Record<string, unknown>, set, cookie: set?.split(';')[0] };
  };
  return { db, sessions, ended, ask };
}

describe('a browser\'s session on a Koala', () => {
  it('holds only an id in the cookie, keeps the person on the server for 14 days without use, and renews that while in use', async () => {
    const { ask } = world();
    const signedIn = await ask('POST', '/sign-in/ann');
    expect(signedIn.set).toMatch(/^koala_sid=s%3A[^;]+; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Lax$/);
    expect(signedIn.set).toContain(`koala_sid=s%3A${String(signedIn.body.sid)}.`);
    expect(signedIn.set).not.toMatch(/ann|sealed/);
    expect(BROWSER_SESSION_SECONDS).toBe(14 * 24 * 60 * 60);
    const expires = Date.parse(/Expires=([^;]+)/.exec(signedIn.set!)![1]!);
    expect(expires - Date.now()).toBeGreaterThan(BROWSER_SESSION_SECONDS * 1000 - 60_000);
    const used = await ask('GET', '/me', signedIn.cookie);
    expect(used.body).toEqual({ sub: 'ann' });
    expect(used.cookie).toBe(signedIn.cookie);
  });

  it('takes no person from a cookie it never made, or from one it made for a session that is gone', async () => {
    const { ask } = world();
    expect((await ask('GET', '/me', 'koala_sid=s%3Aforged.signature')).body).toEqual({ sub: null });
    const signedIn = await ask('POST', '/sign-in/ann');
    const tampered = signedIn.cookie!.replace(/\.[^.]+$/, '.not-its-signature');
    expect((await ask('GET', '/me', tampered)).body).toEqual({ sub: null });
  });

  it('gives a new id at each sign-in, so an id a browser held before is never signed in', async () => {
    const { ask } = world();
    const before = await ask('POST', '/sign-in/ann');
    const again = await ask('POST', '/sign-in/ann', before.cookie);
    expect(again.cookie).not.toBe(before.cookie);
    expect((await ask('GET', '/me', before.cookie)).body).toEqual({ sub: null });
    expect((await ask('GET', '/me', again.cookie)).body).toEqual({ sub: 'ann' });
  });

  it('names its cookie __Host- and sends it only over https when the request arrived over https', async () => {
    const { ask } = world();
    const signedIn = await ask('POST', '/sign-in/ann', undefined, true);
    expect(signedIn.set).toMatch(/^__Host-koala_sid=s%3A[^;]+; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/);
    expect((await ask('GET', '/me', signedIn.cookie, true)).body).toEqual({ sub: 'ann' });
  });

  it('ends one session at once and says so, leaving the person\'s other sessions alone', async () => {
    const { ask, ended } = world();
    const left = await ask('POST', '/sign-in/ann');
    const kept = await ask('POST', '/sign-in/ann');
    await ask('POST', '/sign-out', left.cookie);
    expect((await ask('GET', '/me', left.cookie)).body).toEqual({ sub: null });
    expect((await ask('GET', '/me', kept.cookie)).body).toEqual({ sub: 'ann' });
    expect(ended).toEqual([left.body.sid]);
  });

  it('ends every session of a person, or of one sign-in at root, and says which', async () => {
    const { ask, sessions, ended } = world();
    const ann = await ask('POST', '/sign-in/ann');
    const bob = await ask('POST', '/sign-in/bob');
    expect(await sessions.endOf({ rootSid: 'root-of-bob' })).toEqual([bob.body.sid]);
    expect(await sessions.endOf({ sub: 'ann' })).toEqual([ann.body.sid]);
    expect(ended).toEqual([bob.body.sid, ann.body.sid]);
    expect((await ask('GET', '/me', ann.cookie)).body).toEqual({ sub: null });
  });

  it('holds a person signed in on root itself under a new id, and ends it with the rest of that person\'s sessions', async () => {
    const { ask, sessions, ended } = world();
    const before = await ask('POST', '/sign-in/ann');
    const onRoot = await ask('POST', '/root-sign-in/ann', before.cookie);
    expect(onRoot.cookie).not.toBe(before.cookie);
    expect((await ask('GET', '/account', onRoot.cookie)).body).toEqual({ account: 'ann', at: 5 });
    expect(onRoot.set).not.toMatch(/ann/);
    const bob = await ask('POST', '/root-sign-in/bob');
    expect(await sessions.endOf({ sub: 'ann' })).toEqual([onRoot.body.sid]);
    expect(ended).toEqual([onRoot.body.sid]);
    expect((await ask('GET', '/account', onRoot.cookie)).body).toEqual({ account: null, at: null });
    expect((await ask('GET', '/account', bob.cookie)).body).toEqual({ account: 'bob', at: 5 });
  });
});
