import { BaseService } from './BaseService.js';
import { generateOTP } from '../lib/auth.js';
import type { UserMetadata } from '../lib/types.js';
import https from 'https';

interface Challenge {
  code: string;
  expiresAt: number;
}

export class AuthService extends BaseService {
  private activeChallenges: Map<string, Challenge> = new Map();

  create2FAChallenge(userId: string): string {
    const code = generateOTP();
    this.activeChallenges.set(userId, {
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
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

    if (challenge.code !== code.trim()) {
      return false;
    }

    this.activeChallenges.delete(userId);
    return true;
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
        this.logger.info(`[AuthService] Sending Twilio SMS 2FA to ${phone}...`);
        await this.sendTwilioSMS(accountSid, authToken, fromPhone, phone, `Your Provisioning Platform verification code is: ${code}`);
      } else {
        this.logger.warn(`[DEVELOPER 2FA ALERT] SMS 2FA to ${phone}: Code is ${code}`);
      }
    } else {
      this.logger.warn(`[DEVELOPER 2FA ALERT] Email 2FA to ${user.email}: Code is ${code}`);
    }
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
