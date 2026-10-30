import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import { codeFromMailpit, sessionCookieOf, signUp } from './lib/sign-up.js';
import { call, ownerOnInstance, startSplitStack, type SplitStack } from './lib/split-stack.js';

const step = (message: string) => console.log(`\n▶ ${message}`);

const SUBJECTS = {
  reset: 'Your Koala password reset code',
  signIn: 'Your Koala sign-in code',
  confirm: 'Your Koala confirmation code',
} as const;

async function eventually(what: string, probe: () => Promise<boolean>, tries = 240): Promise<void> {
  for (let tried = 0; tried < tries; tried += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`${what} did not happen after ${tries} tries half a second apart`);
}

const json = (body: unknown) => JSON.stringify(body);

interface Opened { socket: Socket; closed: Promise<string> }

const sockets: Socket[] = [];

const opened = (base: string, cookie: string | undefined): Promise<Opened> => new Promise((resolve, reject) => {
  const socket = connect(base, { transports: ['websocket'], extraHeaders: { cookie: cookie ?? '' }, reconnection: false, forceNew: true });
  sockets.push(socket);
  const closed = new Promise<string>((done) => socket.on('disconnect', (reason) => done(reason)));
  socket.on('connect', () => resolve({ socket, closed }));
  socket.on('connect_error', (err) => reject(err));
});

const closedBy = async (connection: Opened, what: string): Promise<void> => {
  const reason = await Promise.race([connection.closed, new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 60_000))]);
  assert.equal(reason, 'io server disconnect', `${what}: the connection is ${reason}`);
};

async function stages(stack: SplitStack): Promise<void> {
  const { rootUrl, instanceUrl, mailpitApi, owner } = stack;
  const root = (path: string, init: { method?: string; body?: unknown; cookie?: string | undefined } = {}) =>
    call(`${rootUrl}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), cookie: init.cookie, ...(init.body !== undefined ? { body: json(init.body) } : {}) });
  const me = async (cookie: string | undefined) => (await root('/api/auth/me', { cookie })).status;
  const mailed = (email: string, subject: string, after: number) => codeFromMailpit(mailpitApi, email, after, subject);
  const mailsTo = async (email: string, subject: string): Promise<string[]> => {
    const listed = await (await fetch(`${mailpitApi}/api/v1/messages?limit=500`)).json() as { messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }> };
    const found = listed.messages.filter((message) => message.Subject === subject && message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()));
    return Promise.all(found.map(async (message) => ((await (await fetch(`${mailpitApi}/api/v1/message/${message.ID}`)).json()) as { Text: string }).Text));
  };
  const nothingMailedTo = async (email: string): Promise<boolean> => {
    const found = await (await fetch(`${mailpitApi}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json() as { messages?: unknown[] };
    return (found.messages ?? []).length === 0;
  };

  step('a production root refuses a short or leaked password, and hands no sign-up code back: the code only goes by email');
  const invite = async () => {
    const minted = await root('/api/admin/invites', { body: {}, cookie: owner.cookie });
    assert.ok(minted.status === 200 || minted.status === 201, json(minted.body));
    return (minted.body as { code: string }).code;
  };
  const patEmail = `pat-${stack.names.stamp}@split.test`;
  const patInvite = await invite();
  for (const [password, said] of [['short-pw', /at least 12 characters/], ['Password1234', /leaked/]] as const) {
    const refused = await root('/api/auth/register', { body: { email: patEmail, password, inviteCode: patInvite } });
    assert.equal(refused.status, 400, json(refused.body));
    assert.match((refused.body as { error: string }).error, said);
  }
  let patPassword = `pat-${randomBytes(12).toString('base64url')}`;
  const registered = await root('/api/auth/register', { body: { email: patEmail, password: patPassword, inviteCode: patInvite } });
  assert.equal(registered.status, 200, json(registered.body));
  assert.deepEqual(Object.keys(registered.body as object), ['verify'], `root answered a sign-up with ${json(registered.body)}`);
  const verified = await root('/api/auth/register/verify', { body: { id: (registered.body as { verify: string }).verify, code: await mailed(patEmail, 'Your Koala sign-up code', 0) } });
  assert.equal(verified.status, 200, json(verified.body));
  let patCookie = verified.cookie;
  assert.ok(patCookie, 'signing up set no session');
  const throughHelper = await signUp(`${rootUrl}/api`, { email: `quinn-${stack.names.stamp}@split.test`, password: `quinn-${randomBytes(12).toString('base64url')}`, inviteCode: await invite() }, { production: true, mailpitApi });
  assert.ok(sessionCookieOf(throughHelper), `the helper's sign-up failed: ${throughHelper.status} ${throughHelper.error ?? ''}`);
  console.log('  refused short-pw and Password1234; both sign-ups answered with only the pending id, the code read from the mailbox');

  step('a production root asked to reset a password answers alike whether or not the account exists, hands no code back, and mails only an account that does');
  const askedAt = Date.now();
  const nobody = `nobody-${stack.names.stamp}@split.test`;
  const forOwner = await root('/api/auth/password/forgot', { body: { email: owner.email } });
  const forNobody = await root('/api/auth/password/forgot', { body: { email: nobody } });
  assert.equal(forOwner.status, 200, json(forOwner.body));
  assert.equal(forNobody.status, 200, json(forNobody.body));
  assert.deepEqual(Object.keys(forOwner.body as object), ['reset']);
  assert.deepEqual(Object.keys(forNobody.body as object), ['reset']);
  const ownerResetCode = await mailed(owner.email, SUBJECTS.reset, askedAt);
  assert.equal(await nothingMailedTo(nobody), true, 'root emailed an address with no account');
  console.log(`  both answered { reset }; ${owner.email} got a code by email and ${nobody} got nothing`);

  step('signing out on the instance ends that session there, whoever holds its cookie, and closes the connection made with it');
  const leftOnInstance = await ownerOnInstance(stack);
  assert.equal((await call(`${instanceUrl}/api/auth/me`, { cookie: leftOnInstance })).status, 200);
  const leftSocket = await opened(instanceUrl, leftOnInstance);
  const signedOut = await call(`${instanceUrl}/api/auth/logout`, { method: 'POST', body: '{}', cookie: leftOnInstance });
  assert.equal(signedOut.status, 200, json(signedOut.body));
  assert.equal((await call(`${instanceUrl}/api/auth/me`, { cookie: leftOnInstance })).status, 401, 'the instance still took a cookie signed out of');
  await closedBy(leftSocket, 'the instance\'s connection made with a session signed out of');
  await assert.rejects(opened(instanceUrl, leftOnInstance), /Unauthorized/, 'the instance opened a connection for a session signed out of');
  const keptOnInstance = await ownerOnInstance(stack);
  assert.equal((await call(`${instanceUrl}/api/auth/me`, { cookie: keptOnInstance })).status, 200);
  const keptSocket = await opened(instanceUrl, keptOnInstance);
  console.log('  the old instance cookie is refused and its open connection closed; a new sign-in through root works');

  step('the emailed code resets the owner\'s password: every session ends, root\'s and the instance\'s, and only the new password signs in');
  const resetId = (forOwner.body as { reset: string }).reset;
  const wrong = ownerResetCode === '000000' ? '111111' : '000000';
  assert.equal((await root('/api/auth/password/reset', { body: { id: resetId, code: wrong, password: 'a-new-owner-password' } })).status, 401);
  assert.equal((await root('/api/auth/password/reset', { body: { id: resetId, code: ownerResetCode, password: 'password1234' } })).status, 400);
  const ownerPassword = `owner-${randomBytes(12).toString('base64url')}`;
  const reset = await root('/api/auth/password/reset', { body: { id: resetId, code: ownerResetCode, password: ownerPassword } });
  assert.equal(reset.status, 200, json(reset.body));
  assert.equal(await me(owner.cookie), 401, 'root still took the owner\'s session from before the reset');
  await eventually('the instance refusing the owner\'s session once root revoked it', async () => (await call(`${instanceUrl}/api/auth/me`, { cookie: keptOnInstance })).status === 401);
  await closedBy(keptSocket, 'the instance\'s connection made with a session the reset ended');
  const ownerAgain = await root('/api/auth/login', { body: { email: owner.email, password: ownerPassword } });
  assert.equal(ownerAgain.status, 200, json(ownerAgain.body));
  owner.cookie = ownerAgain.cookie!;
  console.log('  root and the instance refuse the old sessions and the instance closed its open connection; the owner signs in with the new password');

  step('changing a password asks for the current one, and ends every other session');
  const elsewhere = (await root('/api/auth/login', { body: { email: patEmail, password: patPassword } })).cookie;
  assert.equal(await me(elsewhere), 200);
  const nextPassword = `pat-${randomBytes(12).toString('base64url')}`;
  assert.equal((await root('/api/auth/password', { body: { password: nextPassword }, cookie: patCookie })).status, 403);
  assert.equal((await root('/api/auth/password', { body: { password: nextPassword, current: 'not-the-password' }, cookie: patCookie })).status, 403);
  const changed = await root('/api/auth/password', { body: { password: nextPassword, current: patPassword }, cookie: patCookie });
  assert.equal(changed.status, 200, json(changed.body));
  assert.deepEqual([await me(elsewhere), await me(patCookie), await me(changed.cookie)], [401, 401, 200]);
  patPassword = nextPassword;
  patCookie = changed.cookie;
  console.log('  refused with none and with a wrong one; changed with it, the other browser signed out');

  step('two-factor goes on only with the password, and then a risky change is refused without a current code');
  assert.equal((await root('/api/auth/2fa/settings', { body: { enabled: true, preferredMethod: 'email' }, cookie: patCookie })).status, 403);
  const on = await root('/api/auth/2fa/settings', { body: { enabled: true, preferredMethod: 'email', password: patPassword }, cookie: patCookie });
  assert.equal(on.status, 200, json(on.body));
  patCookie = on.cookie;
  assert.equal(((await root('/api/auth/me', { cookie: patCookie })).body as { confirmWith: string }).confirmWith, 'two-factor');
  for (const [path, method, body] of [
    ['/api/auth/2fa/settings', 'POST', { enabled: false, password: patPassword }],
    ['/api/account', 'DELETE', { confirm: patEmail, password: patPassword }],
    ['/api/auth/password', 'POST', { password: `pat-${randomBytes(12).toString('base64url')}`, current: patPassword }],
  ] as const) {
    const refused = await root(path, { method, body, cookie: patCookie });
    assert.equal(refused.status, 403, `${method} ${path} answered ${refused.status} ${json(refused.body)}`);
    assert.match((refused.body as { error: string }).error, /code/);
  }
  const confirmAt = Date.now();
  assert.equal((await root('/api/auth/confirm/code', { body: {}, cookie: patCookie })).status, 200);
  const confirmCode = await mailed(patEmail, SUBJECTS.confirm, confirmAt);
  const withCodePassword = `pat-${randomBytes(12).toString('base64url')}`;
  const withCode = await root('/api/auth/password', { body: { password: withCodePassword, current: patPassword, code: confirmCode }, cookie: patCookie });
  assert.equal(withCode.status, 200, json(withCode.body));
  patPassword = withCodePassword;
  patCookie = withCode.cookie;
  assert.equal(await me(patCookie), 200);
  console.log('  turning two-factor off, deleting the account and changing the password were refused without a code; the emailed code let the password change');

  step('Koala sends one account at most five confirmation codes in fifteen minutes, so a stolen cookie cannot mail its owner endlessly');
  for (let n = 0; n < 4; n += 1) assert.equal((await root('/api/auth/confirm/code', { body: {}, cookie: patCookie })).status, 200);
  const sixth = await root('/api/auth/confirm/code', { body: {}, cookie: patCookie });
  assert.equal(sixth.status, 429, json(sixth.body));
  assert.match((sixth.body as { error: string }).error, /5 confirmation codes in the last 15 minutes/);
  console.log(`  the sixth was refused: ${(sixth.body as { error: string }).error}`);

  step('signing out on root makes the old cookie useless and closes the connection made with it');
  const patSocket = await opened(rootUrl, patCookie);
  assert.equal((await root('/api/auth/logout', { body: {}, cookie: patCookie })).status, 200);
  assert.equal(await me(patCookie), 401, 'root still took a cookie signed out of');
  await closedBy(patSocket, 'root\'s connection made with a session signed out of');
  const signedOutCookie = patCookie;
  console.log('  the cookie is refused once signed out of, and its open connection closed');

  step('wrong two-factor codes count per account across sign-ins: a fresh password sign-in does not start the count again');
  const signIn = async () => {
    const at = Date.now();
    const answer = await root('/api/auth/login', { body: { email: patEmail, password: patPassword } });
    if (answer.status !== 200) return { status: answer.status, body: answer.body, challenge: '', code: '' };
    return { status: answer.status, body: answer.body, challenge: (answer.body as { challenge: string }).challenge, code: await mailed(patEmail, SUBJECTS.signIn, at) };
  };
  const verify = (challenge: string, code: string) => root('/api/auth/2fa/verify', { body: { challenge, code } });
  const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');
  const signedInNow = await signIn();
  const throughCode = await verify(signedInNow.challenge, signedInNow.code);
  assert.equal(throughCode.status, 200, json(throughCode.body));
  const stillSignedIn = throughCode.cookie;
  const first = await signIn();
  assert.equal(first.status, 200, json(first.body));
  for (let n = 0; n < 3; n += 1) assert.equal((await verify(first.challenge, wrongFor(first.code))).status, 400);
  const second = await signIn();
  assert.equal(second.status, 200, json(second.body));
  assert.equal((await verify(second.challenge, wrongFor(second.code))).status, 400);
  const locked = await verify(second.challenge, wrongFor(second.code));
  assert.equal(locked.status, 429, json(locked.body));
  assert.equal((await verify(second.challenge, second.code)).status, 429, 'the right code was taken while the account\'s codes were locked');
  const third = await root('/api/auth/login', { body: { email: patEmail, password: patPassword } });
  assert.equal(third.status, 429, json(third.body));
  assert.match((third.body as { error: string }).error, /wrong codes/);
  console.log(`  locked after the fifth wrong code over two sign-ins: ${(third.body as { error: string }).error}`);

  step('ten wrong passwords lock the account to other browsers and tell its person once, ending none of their sessions; the lock and a signed-out session both survive root restarting');
  const stillOpen = await opened(rootUrl, stillSignedIn);
  for (let n = 0; n < 10; n += 1) assert.equal((await root('/api/auth/login', { body: { email: patEmail, password: `wrong-${n}-password` } })).status, 401);
  const lockedOut = await root('/api/auth/login', { body: { email: patEmail, password: patPassword } });
  assert.equal(lockedOut.status, 429, json(lockedOut.body));
  assert.match((lockedOut.body as { error: string }).error, /failed sign-ins/);
  const lockSubject = 'Your Koala account is locked to other browsers';
  await eventually('the person told of the lock by email', async () => (await mailsTo(patEmail, lockSubject)).length > 0);
  const told = await mailsTo(patEmail, lockSubject);
  assert.equal(told.length, 1, `the person was told ${told.length} times`);
  assert.match(told[0]!, /tried your Koala password 10 times from \S+/);
  assert.match(told[0]!, /locked to other browsers for 15 minutes/);
  assert.match(told[0]!, /you may want to change your password/);
  assert.equal(await me(stillSignedIn), 200, 'the lock ended a session of the person');
  assert.equal(stillOpen.socket.connected, true, 'the lock closed the person\'s open connection');
  console.log(`  told once: ${told[0]!.split('\n')[0]}`);
  execFileSync('docker', ['restart', stack.names.containers.root], { stdio: 'ignore' });
  await eventually('root answering again after its restart', async () => (await fetch(`${rootUrl}/api/identity/keys`).catch(() => undefined))?.status === 200, 1200);
  const stillLocked = await root('/api/auth/login', { body: { email: patEmail, password: patPassword } });
  assert.equal(stillLocked.status, 429, `the lock did not survive the restart: ${stillLocked.status} ${json(stillLocked.body)}`);
  assert.equal(await me(signedOutCookie), 401, 'after the restart root took a cookie signed out of before it');
  assert.equal(await me(owner.cookie), 200, 'after the restart root refused a session nobody ended');
  assert.equal(await me(stillSignedIn), 200, 'after the restart root refused the locked person\'s own session');
  assert.equal((await mailsTo(patEmail, lockSubject)).length, 1, 'the person was told of one lock more than once');
  console.log('  still locked after the restart, and the signed-out cookie still refused');
}

async function main(): Promise<void> {
  step('a root, an instance and a hub of their own start in containers from this commit\'s image, sending mail to a mailbox of their own');
  const stack = await startSplitStack();
  console.log(`  root ${stack.rootUrl}, instance ${stack.instanceUrl}, hub ${stack.hubUrl}; mailbox ${stack.mailpitApi}`);
  try {
    await stages(stack);
  } catch (err) {
    for (const side of ['root', 'instance', 'hub'] as const) console.error(`\n── ${side}'s last lines ──\n${stack.logs(side, 40)}`);
    throw err;
  } finally {
    for (const socket of sockets) socket.close();
    await stack.stop();
  }
  console.log('\naccount hardening live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
