import { createHash } from 'node:crypto';

export interface FileShare {
  id: string;
  token: string;
  ownerId: string;
  projectId?: string | undefined;
  path: string;
  etag?: string | undefined;
  name: string;
  createdAt: string;
  expiresAt: string;
}

export const SHARE_DAYS = [1, 7, 30] as const;
export type ShareDays = typeof SHARE_DAYS[number];

export const SHARE_PREFIX = '/share/';

export const isShareDays = (value: unknown): value is ShareDays => SHARE_DAYS.includes(value as ShareDays);

export const shareExpires = (now: string, days: ShareDays): string => new Date(Date.parse(now) + days * 86_400_000).toISOString();

export const shareLive = (share: Pick<FileShare, 'expiresAt'>, now: string): boolean => Date.parse(share.expiresAt) > Date.parse(now);

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export const shareTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
