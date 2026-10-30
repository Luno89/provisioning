export const RESET_MINUTES = 30;
export const RESET_WRONG_CODES = 5;
export const RESET_CODES_SENT = 5;

export interface PasswordReset {
  id: string;
  ownerId?: string | undefined;
  email: string;
  codeHash: string;
  wrong: number;
  sent: number;
  expiresAt: Date;
}

export const resetExpiry = (now: Date): Date => new Date(now.getTime() + RESET_MINUTES * 60_000);

export const resetLive = (reset: Pick<PasswordReset, 'expiresAt'> | undefined, now: Date): reset is PasswordReset =>
  reset !== undefined && reset.expiresAt.getTime() > now.getTime();

export const resetCodeMail = (code: string): { subject: string; text: string } => ({
  subject: 'Your Koala password reset code',
  text: `Your Koala password reset code is ${code}. Enter it where you asked to reset your password, with your new password; it works for ${RESET_MINUTES} minutes.\n\nResetting your password signs you out everywhere. If you did not ask, ignore this email and nothing changes.`,
});

export const takenAddressMail = (appUrl: string): { subject: string; text: string } => ({
  subject: 'You already have a Koala account',
  text: `Someone just tried to sign up for Koala at ${appUrl} with this address, which already has an account. If it was you, sign in there, or use "Forgot password" on the sign-in page.\n\nIf it was not you, ignore this email and nothing changes.`,
});
