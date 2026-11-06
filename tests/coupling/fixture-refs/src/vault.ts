import { declared, type Feed, type Secret } from './secret.js';

export function asked(secret: Secret): boolean {
  return secret.source === 'person';
}

export function feedSource(feed: Feed): string {
  return feed.source;
}

export const first = declared.map((secret) => secret.source);
