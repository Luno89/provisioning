import {
  ACCOUNT_KEY, attemptsKeyFor, BaseService, CONFIRM_CODES, confirmCodesKeyFor, confirmCodesSaid, generateOTP, LOCKOUT, lockedSaid, passwordMatches, SignInAttemptLog, TWO_FACTOR_LOCKOUT, twoFactorKeyFor, twoFactorLockedSaid,
  type Database, type MailMessage, type UserMetadata,
} from '../../platform/index.js';
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { linkedTo, providerMatch, type ProviderPerson } from '../lib/provider-sign-in.js';
import { signUpCodeMail } from '../lib/sign-up.js';
import { lockNotice } from '../lib/lock-notice.js';
import {
  confirmCodeMail, confirmWith, PROOF_ASKED, passwordChangeNeeds, sameTwoFactorCode, signInCodeMail, twoFactorCodeHash, twoFactorCodeId, twoFactorExpiry, twoFactorLive,
  type CodePurpose, type Proof,
} from '../lib/second-factor.js';

export interface CodeMail {
  available(): { ok: true } | { ok: false; why: string };
  toAddress(to: string, message: MailMessage): Promise<void>;
}

export type Checked = { kind: 'ok' } | { kind: 'wrong' } | { kind: 'locked'; said: string };

export type Refusal = { status: 403 | 429; error: string };

export type SignedInDevice = { account: string; id: string } | undefined;

export class AuthService extends BaseService {
  private readonly attempts: SignInAttemptLog;
  private readonly now: () => number;

  constructor(db: Database, private readonly options: {
    mail?: CodeMail | undefined;
    production?: boolean | undefined;
    push?: { toPerson(ownerId: string, message: { title: string; body: string; path?: string | undefined; tag?: string | undefined }): Promise<number> } | undefined;
    now?: (() => number) | undefined;
  } = {}) {
    super(db);
    this.now = options.now ?? (() => Date.now());
    this.attempts = new SignInAttemptLog(db.platform, this.now);
  }

  async checkPassword(account: string, user: UserMetadata | undefined, password: string, device: SignedInDevice, from?: string | undefined): Promise<Checked> {
    const key = attemptsKeyFor(account, device);
    const locked = await this.attempts.lockedUntil(key, LOCKOUT);
    if (locked !== undefined) return { kind: 'locked', said: lockedSaid(locked, this.now()) };
    if (await passwordMatches(password, user?.passwordHash)) {
      await this.attempts.succeeded(key);
      return { kind: 'ok' };
    }
    const counted = await this.attempts.failed(key, LOCKOUT);
    if (counted.locked && user && key.startsWith(ACCOUNT_KEY)) void this.tellLocked(user, from);
    return { kind: 'wrong' };
  }

  async tellLocked(user: UserMetadata, from: string | undefined): Promise<void> {
    const notice = lockNotice(from);
    const told = (how: string) => (err: Error) => this.logger.warn(`[AuthService] ${user.id} was not told by ${how} that their account is locked: ${err.message}`);
    if (this.options.mail?.available().ok) await this.options.mail.toAddress(user.email, notice.mail).catch(told('email'));
    await this.options.push?.toPerson(user.id, notice.push).catch(told('push'));
  }

  async forgetPasswordFailures(account: string): Promise<void> {
    await this.attempts.succeeded(attemptsKeyFor(account, undefined));
  }

  async codesLockedSaid(userId: string): Promise<string | undefined> {
    const until = await this.attempts.lockedUntil(twoFactorKeyFor(userId), TWO_FACTOR_LOCKOUT);
    return until === undefined ? undefined : twoFactorLockedSaid(until, this.now());
  }

  async sendCode(user: UserMetadata, purpose: CodePurpose): Promise<{ kind: 'sent' } | { kind: 'locked'; said: string }> {
    const locked = await this.codesLockedSaid(user.id);
    if (locked) return { kind: 'locked', said: locked };
    const code = generateOTP();
    const id = twoFactorCodeId(user.id, purpose);
    await this.db.accounts.saveTwoFactorCode({ id, ownerId: user.id, codeHash: twoFactorCodeHash(id, code), expiresAt: twoFactorExpiry(this.now()) });
    await this.send2FACode(user, code, purpose);
    return { kind: 'sent' };
  }

  async sendConfirmCode(user: UserMetadata): Promise<{ kind: 'sent' } | { kind: 'locked'; said: string } | { kind: 'limited'; said: string }> {
    const key = confirmCodesKeyFor(user.id);
    const full = await this.attempts.fullUntil(key, CONFIRM_CODES);
    if (full !== undefined) return { kind: 'limited', said: confirmCodesSaid(full, this.now()) };
    const locked = await this.codesLockedSaid(user.id);
    if (locked) return { kind: 'locked', said: locked };
    await this.attempts.failed(key, CONFIRM_CODES);
    return this.sendCode(user, 'confirm');
  }

  async checkCode(userId: string, purpose: CodePurpose, code: string): Promise<Checked> {
    const locked = await this.codesLockedSaid(userId);
    if (locked) return { kind: 'locked', said: locked };
    const id = twoFactorCodeId(userId, purpose);
    const held = await this.db.accounts.getTwoFactorCode(id);
    if (twoFactorLive(held, this.now()) && sameTwoFactorCode(held, code) && await this.db.accounts.takeTwoFactorCode(id)) {
      await this.attempts.succeeded(twoFactorKeyFor(userId));
      return { kind: 'ok' };
    }
    const counted = await this.attempts.failed(twoFactorKeyFor(userId), TWO_FACTOR_LOCKOUT);
    if (!counted.locked) return { kind: 'wrong' };
    await this.db.accounts.dropTwoFactorCodesOf(userId);
    return { kind: 'locked', said: (await this.codesLockedSaid(userId)) ?? twoFactorLockedSaid(this.now() + TWO_FACTOR_LOCKOUT.forMs, this.now()) };
  }

  private async proven(user: UserMetadata, proof: Proof, device: SignedInDevice, by: 'password' | 'code', from?: string | undefined): Promise<Refusal | undefined> {
    if (by === 'password') {
      if (!proof.password) return { status: 403, error: PROOF_ASKED.password };
      const checked = await this.checkPassword(user.email, user, proof.password, device, from);
      if (checked.kind === 'locked') return { status: 429, error: checked.said };
      return checked.kind === 'ok' ? undefined : { status: 403, error: 'That is not your password' };
    }
    if (!proof.code) return { status: 403, error: PROOF_ASKED[confirmWith(user)] };
    const checked = await this.checkCode(user.id, 'confirm', proof.code);
    if (checked.kind === 'locked') return { status: 429, error: checked.said };
    return checked.kind === 'ok' ? undefined : { status: 403, error: 'That code is not the one we sent, or it has expired; ask for a new one' };
  }

  async confirmProblem(user: UserMetadata, proof: Proof, device: SignedInDevice, from?: string | undefined): Promise<Refusal | undefined> {
    return this.proven(user, proof, device, confirmWith(user) === 'password' ? 'password' : 'code', from);
  }

  async passwordChangeProblem(user: UserMetadata, proof: Proof & { current?: string | undefined }, device: SignedInDevice, from?: string | undefined): Promise<Refusal | undefined> {
    const needs = passwordChangeNeeds(user);
    if (needs.current) {
      if (!proof.current) return { status: 403, error: 'Enter your current password to change it' };
      const refused = await this.proven(user, { password: proof.current }, device, 'password', from);
      if (refused) return refused.error === 'That is not your password' ? { ...refused, error: 'That is not your current password' } : refused;
    }
    return needs.code ? this.proven(user, proof, device, 'code') : undefined;
  }

  private shownToDeveloper(where: string, code: string): void {
    if (this.options.production) throw new Error(`a sign-in code cannot be sent ${where}`);
    this.logger.warn(`[DEVELOPER 2FA ALERT] ${where}: Code is ${code}`);
  }

  async signInWithProvider(
    person: ProviderPerson,
    invite: string | undefined,
    consumeInvite: (code: string | undefined, userId: string, isFirstUser: boolean, email?: string) => Promise<string | null>,
  ): Promise<{ kind: 'refused'; why: string } | { kind: 'signed-in'; user: UserMetadata } | { kind: 'second-factor'; user: UserMetadata }> {
    const match = providerMatch(person, await this.db.accounts.getUserBySignInLink(person.issuer, person.subject), await this.db.accounts.getUserByEmail(person.email));
    if (match.kind === 'refused') return match;
    let user: UserMetadata;
    if (match.kind === 'new') {
      const isFirstUser = (await this.db.accounts.getUsers()).length === 0;
      const userId = uuidv4();
      const refused = await consumeInvite(invite, userId, isFirstUser, person.email);
      if (refused) return { kind: 'refused', why: refused };
      user = {
        id: userId,
        email: person.email,
        signInLinks: [{ issuer: person.issuer, subject: person.subject }],
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
        ...(isFirstUser ? { roles: ['operator' as const] } : {}),
      };
      await this.db.accounts.saveUser(user);
    } else {
      user = match.user;
      if (match.link) {
        user = linkedTo(user, person);
        await this.db.accounts.saveUser(user);
      }
    }
    if (user.removal) return { kind: 'refused', why: 'This account is being removed' };
    if (!user.twoFactorEnabled) return { kind: 'signed-in', user };
    const sent = await this.sendCode(user, 'sign-in');
    if (sent.kind === 'locked') return { kind: 'refused', why: sent.said };
    return { kind: 'second-factor', user };
  }

  sendingProblem(method: string | undefined): string | undefined {
    if (!this.options.production) return undefined;
    if (method === 'sms') {
      return process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER
        ? undefined
        : 'sign-in codes by SMS need Twilio, which this server does not have set up';
    }
    const sending = this.options.mail?.available();
    return sending?.ok ? undefined : `sign-in codes by email need this server to send email, and ${sending ? (sending as { why: string }).why : 'it sends none'}`;
  }

  async emailCode(email: string, message: MailMessage, code: string | undefined): Promise<{ kind: 'sent' } | { kind: 'shown'; code?: string | undefined } | { kind: 'refused'; why: string }> {
    const sending = this.options.mail?.available();
    if (this.options.mail && sending?.ok) {
      await this.options.mail.toAddress(email, message);
      return { kind: 'sent' };
    }
    if (this.options.production) {
      return { kind: 'refused', why: `This server cannot send email yet (${sending && !sending.ok ? sending.why : 'it sends none'}), so it cannot confirm your address; ask whoever runs it` };
    }
    this.logger.warn(`[DEVELOPER EMAIL] "${message.subject}" for ${email}, since ${sending && !sending.ok ? sending.why : 'this server sends no email'}${code ? `: ${code}` : ''}`);
    return { kind: 'shown', ...(code ? { code } : {}) };
  }

  codeDelivery(): { kind: 'mail' } | { kind: 'shown' } | { kind: 'refused'; why: string } {
    const sending = this.options.mail?.available();
    if (this.options.mail && sending?.ok) return { kind: 'mail' };
    if (this.options.production) return { kind: 'refused', why: `This server cannot send email yet (${sending && !sending.ok ? sending.why : 'it sends none'}), so it cannot send you a code; ask whoever runs it` };
    return { kind: 'shown' };
  }

  mailInBackground(email: string, message: MailMessage): void {
    this.options.mail?.toAddress(email, message).catch((err: Error) => this.logger.warn(`[AuthService] "${message.subject}" did not reach ${email}: ${err.message}`));
  }

  sendSignUpCode(email: string, code: string): ReturnType<AuthService['emailCode']> {
    return this.emailCode(email, signUpCodeMail(code), code);
  }

  async send2FACode(user: UserMetadata, code: string, purpose: CodePurpose = 'sign-in'): Promise<void> {
    const method = user.twoFactorEnabled ? user.twoFactorPreferredMethod || 'email' : 'email';

    if (method === 'sms') {
      const phone = user.twoFactorPhone;
      if (!phone) {
        throw new Error('User has no phone number configured for SMS 2FA.');
      }

      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromPhone = process.env.TWILIO_PHONE_NUMBER;

      if (accountSid && authToken && fromPhone) {
        this.logger.info('[AuthService] Sending a 2FA code by Twilio SMS');
        await this.sendTwilioSMS(accountSid, authToken, fromPhone, phone, purpose === 'confirm' ? `Your Koala confirmation code is: ${code}` : `Your Koala sign-in code is: ${code}`);
      } else {
        this.shownToDeveloper(`by SMS to ${phone}, since Twilio is not set up`, code);
      }
      return;
    }

    const mail = this.options.mail;
    const sending = mail?.available();
    if (mail && sending?.ok) {
      await mail.toAddress(user.email, purpose === 'confirm' ? confirmCodeMail(code) : signInCodeMail(code));
      return;
    }
    this.shownToDeveloper(`by email to ${user.email}, since ${sending && !sending.ok ? sending.why : 'this server sends no email'}`, code);
  }

  private sendTwilioSMS(
    accountSid: string,
    authToken: string,
    from: string,
    to: string,
    body: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        From: from,
        To: to,
        Body: body,
      }).toString();

      const options = {
        hostname: 'api.twilio.com',
        port: 443,
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
      };

      const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Twilio API responded with status ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', (err) => { reject(err); });
      req.write(postData);
      req.end();
    });
  }
}
