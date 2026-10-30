import { randomUUID } from 'node:crypto';
import { generateOTP, hashPassword, type AccessRevocations, type Database, type UserMetadata } from '../../platform/index.js';
import { passwordProblem, type BreachedPasswords } from '../lib/passwords.js';
import { RESET_WRONG_CODES, resetCodeMail, resetExpiry, resetLive } from '../lib/password-reset.js';
import { emailProblem, normalEmail, sameSignUpCode, signUpCodeHash } from '../lib/sign-up.js';
import type { AuthService, SignedInDevice } from './AuthService.js';

export type Answered<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

const RESET_GONE = 'This password reset has ended; ask for a new one';

export class PasswordService {
  constructor(private readonly deps: {
    db: Pick<Database, 'accounts'>;
    auth: Pick<AuthService, 'codeDelivery' | 'mailInBackground' | 'passwordChangeProblem' | 'forgetPasswordFailures'>;
    breached: BreachedPasswords;
    revocations?: Pick<AccessRevocations, 'revoked'> | undefined;
    now?: (() => Date) | undefined;
  }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  newPasswordProblem(password: unknown, email?: string): string | undefined {
    return passwordProblem(password, this.deps.breached, email);
  }

  private deliver(email: string, ownerId: string | undefined, code: string): Answered<{ devCode?: string | undefined }> {
    const delivery = this.deps.auth.codeDelivery();
    if (delivery.kind === 'refused') return { ok: false, status: 503, error: delivery.why };
    if (!ownerId) return { ok: true };
    if (delivery.kind === 'shown') return { ok: true, devCode: code };
    this.deps.auth.mailInBackground(email, resetCodeMail(code));
    return { ok: true };
  }

  async forgot(given: unknown): Promise<Answered<{ reset: string; devCode?: string | undefined }>> {
    const email = normalEmail(given);
    const malformed = emailProblem(email);
    if (malformed) return { ok: false, status: 400, error: malformed };
    const delivery = this.deps.auth.codeDelivery();
    if (delivery.kind === 'refused') return { ok: false, status: 503, error: delivery.why };
    const user = await this.deps.db.accounts.getUserByEmail(email);
    const ownerId = user && !user.removal ? user.id : undefined;
    const id = randomUUID();
    const code = generateOTP();
    await this.deps.db.accounts.savePasswordReset({
      id,
      ...(ownerId ? { ownerId } : {}),
      email,
      codeHash: signUpCodeHash(id, ownerId ? code : randomUUID()),
      wrong: 0,
      sent: 1,
      expiresAt: resetExpiry(this.now()),
    });
    const sent = this.deliver(email, ownerId, code);
    return sent.ok ? { ...sent, reset: id } : sent;
  }

  async resend(id: unknown): Promise<Answered<{ reset: string; devCode?: string | undefined }>> {
    const reset = typeof id === 'string' && id ? await this.deps.db.accounts.getPasswordReset(id) : undefined;
    if (!resetLive(reset, this.now())) return { ok: false, status: 410, error: RESET_GONE };
    const code = generateOTP();
    if (!await this.deps.db.accounts.newResetCode(reset.id, signUpCodeHash(reset.id, reset.ownerId ? code : randomUUID()), resetExpiry(this.now()))) {
      return { ok: false, status: 429, error: 'We have sent this reset enough codes; ask for a new one' };
    }
    const sent = this.deliver(reset.email, reset.ownerId, code);
    return sent.ok ? { ...sent, reset: reset.id } : sent;
  }

  async reset(input: { id: unknown; code: unknown; password: unknown }): Promise<Answered<{ email: string }>> {
    if (typeof input.code !== 'string' || !/^\s*\d{6}\s*$/.test(input.code)) return { ok: false, status: 400, error: 'Enter the six digits from the email' };
    const reset = typeof input.id === 'string' && input.id ? await this.deps.db.accounts.getPasswordReset(input.id) : undefined;
    if (!resetLive(reset, this.now())) return { ok: false, status: 410, error: RESET_GONE };
    const weak = this.newPasswordProblem(input.password, reset.email);
    if (weak) return { ok: false, status: 400, error: weak };
    if (!sameSignUpCode(reset, input.code) || !reset.ownerId) {
      const wrong = await this.deps.db.accounts.wrongResetCode(reset.id);
      if (wrong >= RESET_WRONG_CODES) {
        await this.deps.db.accounts.deletePasswordReset(reset.id);
        return { ok: false, status: 410, error: 'That code was wrong too many times; ask for a new reset' };
      }
      return { ok: false, status: 401, error: 'That code is not the one we sent; check the email and try again' };
    }
    if (!await this.deps.db.accounts.deletePasswordReset(reset.id)) return { ok: false, status: 410, error: RESET_GONE };
    const user = await this.deps.db.accounts.getUserById(reset.ownerId);
    if (!user || user.removal) return { ok: false, status: 410, error: RESET_GONE };
    await this.replace(user, input.password as string);
    await this.deps.auth.forgetPasswordFailures(user.email);
    return { ok: true, email: user.email };
  }

  async change(signedIn: UserMetadata, input: { password: unknown; current: unknown; code: unknown }, device: SignedInDevice): Promise<Answered<{ user: UserMetadata }>> {
    const user = await this.deps.db.accounts.getUserById(signedIn.id);
    if (!user || user.removal) return { ok: false, status: 401, error: 'Sign in first' };
    const weak = this.newPasswordProblem(input.password, user.email);
    if (weak) return { ok: false, status: 400, error: weak };
    const refused = await this.deps.auth.passwordChangeProblem(user, {
      ...(typeof input.current === 'string' && input.current ? { current: input.current } : {}),
      ...(typeof input.code === 'string' && input.code.trim() ? { code: input.code.trim() } : {}),
    }, device);
    if (refused) return { ok: false, ...refused };
    return { ok: true, user: await this.replace(user, input.password as string) };
  }

  private async replace(user: UserMetadata, password: string): Promise<UserMetadata> {
    const changed: UserMetadata = { ...user, passwordHash: await hashPassword(password), sessionsEndedAt: this.now().toISOString() };
    await this.deps.db.accounts.saveUser(changed);
    await this.deps.revocations?.revoked({ personId: user.id, because: 'password-or-2fa', at: changed.sessionsEndedAt! });
    return changed;
  }
}
