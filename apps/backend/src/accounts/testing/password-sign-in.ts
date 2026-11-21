import { hashPassword } from '../../platform/lib/auth.js';
import type { AccountsStore } from '../store.js';

const TEST_PASSWORD = 'the-password-this-test-signs-in-with';

export async function signedInWithPassword(at: string, accounts: Pick<AccountsStore, 'getUserById' | 'saveUser'>, id: string): Promise<Response> {
  const account = await accounts.getUserById(id);
  if (!account) throw new Error(`there is no account ${id} to sign in`);
  if (!account.passwordHash) await accounts.saveUser({ ...account, passwordHash: await hashPassword(TEST_PASSWORD) });
  const answer = await fetch(`${at}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: TEST_PASSWORD }) });
  if (answer.status !== 200) throw new Error(`signing ${id} in answered ${answer.status}: ${await answer.text()}`);
  return answer;
}

export const sessionCookieOf = (answer: Response): string => {
  const pair = answer.headers.getSetCookie().map((line) => line.split(';')[0]!).find((one) => /^(__Host-)?koala_sid=./.test(one));
  if (!pair) throw new Error(`signing in at ${answer.url} set no session cookie`);
  return pair;
};
