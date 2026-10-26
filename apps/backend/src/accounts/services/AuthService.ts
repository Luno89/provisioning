import { BaseService, generateOTP, type Database, type MailMessage, type UserMetadata } from '../../platform/index.js';
import { timingSafeEqual } from 'node:crypto';
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { providerMatch, type ProviderPerson } from '../lib/provider-sign-in.js';

interface Challenge {
  code: string;
  expiresAt: number;
  wrong: number;
}

export const WRONG_CODES_ALLOWED = 5;

export interface CodeMail {
  available(): { ok: true } | { ok: false; why: string };
  toAddress(to: string, message: MailMessage): Promise<void>;
}

const sameCode = (expected: string, given: string): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class AuthService extends BaseService {
  private activeChallenges: Map<string, Challenge> = new Map();

  constructor(db: Database, private readonly options: { mail?: CodeMail | undefined; production?: boolean | undefined } = {}) {
    super(db);
  }

  create2FAChallenge(userId: string): string {
    const code = generateOTP();
    this.activeChallenges.set(userId, {
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
      wrong: 0,
    });
    return code;
  }

  verify2FAChallenge(userId: string, code: string): boolean {
    const challenge = this.activeChallenges.get(userId);
    if (!challenge) return false;

    if (challenge.expiresAt < Date.now()) {
      this.activeChallenges.delete(userId);
      return false;
    }

    if (!sameCode(challenge.code, code.trim())) {
      challenge.wrong += 1;
      if (challenge.wrong >= WRONG_CODES_ALLOWED) this.activeChallenges.delete(userId);
      return false;
    }

    this.activeChallenges.delete(userId);
    return true;
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
    const match = providerMatch(person, await this.db.accounts.getUserByProvider(person.field, person.id), await this.db.accounts.getUserByEmail(person.email));
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
        [person.field]: person.id,
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
        ...(isFirstUser ? { isAdmin: true } : {}),
      } as UserMetadata;
      await this.db.accounts.saveUser(user);
    } else {
      user = match.user;
      if (match.link) {
        user = { ...user, [person.field]: person.id };
        await this.db.accounts.saveUser(user);
      }
    }
    if (user.removal) return { kind: 'refused', why: 'This account is being removed' };
    if (!user.twoFactorEnabled) return { kind: 'signed-in', user };
    await this.send2FACode(user, this.create2FAChallenge(user.id));
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

  async send2FACode(user: UserMetadata, code: string): Promise<void> {
    const method = user.twoFactorPreferredMethod || 'email';

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
        await this.sendTwilioSMS(accountSid, authToken, fromPhone, phone, `Your Koala sign-in code is: ${code}`);
      } else {
        this.shownToDeveloper(`by SMS to ${phone}, since Twilio is not set up`, code);
      }
      return;
    }

    const mail = this.options.mail;
    const sending = mail?.available();
    if (mail && sending?.ok) {
      await mail.toAddress(user.email, { subject: 'Your Koala sign-in code', text: `Your Koala sign-in code is ${code}. It works for five minutes.` });
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
