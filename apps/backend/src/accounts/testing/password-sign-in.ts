import { hashPassword } from '../../platform/lib/auth.js';
import { signInWithPassword, type SignedInAtRoot } from '../services/sign-in/password-at-root.js';
import type { AccountsStore } from '../store.js';

const TEST_PASSWORD = 'the-password-this-test-signs-in-with';

export async function signedInWithPassword(at: string, accounts: Pick<AccountsStore, 'getUserById' | 'saveUser'>, id: string, send: typeof fetch = fetch): Promise<SignedInAtRoot> {
  const account = await accounts.getUserById(id);
  if (!account) throw new Error(`there is no account ${id} to sign in`);
  if (!account.passwordHash) await accounts.saveUser({ ...account, passwordHash: await hashPassword(TEST_PASSWORD) });
  return signInWithPassword(at, { email: account.email, password: TEST_PASSWORD }, send);
}
