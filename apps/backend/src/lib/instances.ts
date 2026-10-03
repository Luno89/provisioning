export type InstanceStatus = 'waiting' | 'joined' | 'installing' | 'ready' | 'failed';

export const INSTANCE_STATUSES: readonly InstanceStatus[] = ['waiting', 'joined', 'installing', 'ready', 'failed'];

export interface InstanceRecord {
  id: string;
  ownerId: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  status?: InstanceStatus | undefined;
  detail?: string | undefined;
  credentialHash?: string | undefined;
  machine?: string | undefined;
}

export interface JoinToken {
  hash: string;
  ownerId: string;
  instanceId: string;
  expiresAt: string;
}

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function instanceProblem(candidate: { id: string; ownerId: string; url: string }): string | null {
  if (!ID.test(candidate.id)) return 'an instance id is lower-case letters, digits and dashes';
  if (!candidate.ownerId.trim()) return 'an instance needs an owner';
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return `"${candidate.url}" is not a URL`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'an instance is reached over http or https';
  if (url.pathname !== '/' || url.search || url.hash) return 'an instance URL is an origin, with no path';
  return null;
}
