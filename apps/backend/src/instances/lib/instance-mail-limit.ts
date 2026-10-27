export const INSTANCE_MAIL_PER_HOUR = 60;

const HOUR_MS = 60 * 60 * 1000;

export interface MailWindow {
  sent: number[];
  toldUntil?: number | undefined;
}

export type MailVerdict = { send: true; window: MailWindow } | { send: false; tell: boolean; until: number; window: MailWindow };

export function mailVerdict(window: MailWindow | undefined, now: number, perHour = INSTANCE_MAIL_PER_HOUR): MailVerdict {
  const sent = (window?.sent ?? []).filter((at) => now - at < HOUR_MS);
  const toldUntil = window?.toldUntil !== undefined && window.toldUntil > now ? window.toldUntil : undefined;
  if (sent.length < perHour) return { send: true, window: { sent: [...sent, now], ...(toldUntil ? { toldUntil } : {}) } };
  const until = sent[sent.length - perHour]! + HOUR_MS;
  return { send: false, tell: toldUntil === undefined, until, window: { sent, toldUntil: toldUntil ?? until } };
}

export function heldBackMail(until: number, perHour = INSTANCE_MAIL_PER_HOUR): { subject: string; text: string } {
  const at = new Date(until).toISOString().replace('T', ' ').slice(0, 16);
  return {
    subject: 'Koala is holding back email from your instance',
    text: [
      `Your instance has sent ${perHour} emails in the last hour, as many as an hour allows.`,
      `Koala holds back the rest until ${at} UTC.`,
      'Every alert still shows as a notice in Koala, so nothing is lost; only its email is not sent.',
    ].join('\n\n'),
  };
}
