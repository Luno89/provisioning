import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface FirstAdminSetup {
  code: string | undefined;
  say: string | undefined;
}

export function firstAdminSetup(env: Record<string, string | undefined>, noAccountYet: boolean, generate = () => randomBytes(12).toString('base64url')): FirstAdminSetup {
  const set = env.ADMIN_SETUP_CODE?.trim();
  if (set) return { code: set, say: noAccountYet ? 'No account yet: the first sign-up becomes the admin with the setup code in ADMIN_SETUP_CODE' : undefined };
  if (env.NODE_ENV === 'production') return { code: undefined, say: noAccountYet ? 'No account yet, and ADMIN_SETUP_CODE is not set: nobody can sign up until it is' : undefined };
  const code = generate();
  return { code, say: noAccountYet ? `No account yet: sign up with the setup code ${code} to become the admin` : undefined };
}

export function setupCodeProblem(setupCode: string | undefined, given: string | undefined): string | undefined {
  if (!setupCode) return 'This Koala has no account yet and no setup code is set (ADMIN_SETUP_CODE), so nobody can sign up';
  const expected = Buffer.from(setupCode);
  const typed = Buffer.from(given ?? '');
  return expected.length === typed.length && timingSafeEqual(expected, typed)
    ? undefined
    : 'This Koala has no account yet: the first sign-up needs its setup code, which its installer printed';
}
