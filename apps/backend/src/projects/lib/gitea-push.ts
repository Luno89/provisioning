import { isRecord, listAt, recordAt } from '../../platform/lib/json-shapes.js';

export interface GiteaPush {
  ref: string;
  after: string;
  defaultBranch: string;
  commits: { added: string[]; modified: string[]; removed: string[] }[];
}

const paths = (value: unknown, key: string): string[] => listAt(value, key).filter((entry): entry is string => typeof entry === 'string');

export function giteaPushOf(body: unknown): GiteaPush | undefined {
  if (!isRecord(body)) return undefined;
  const { ref, after } = body;
  if (typeof ref !== 'string' || !ref || typeof after !== 'string' || !after) return undefined;
  const branch = recordAt(body, 'repository').default_branch;
  return {
    ref: ref.replace('refs/heads/', ''),
    after,
    defaultBranch: typeof branch === 'string' && branch ? branch : 'main',
    commits: listAt(body, 'commits').map((commit) => ({ added: paths(commit, 'added'), modified: paths(commit, 'modified'), removed: paths(commit, 'removed') })),
  };
}

export function pushToBuild(body: unknown): { build: GiteaPush } | { ignored: string } {
  const push = giteaPushOf(body);
  if (!push) return { ignored: 'not a push event' };
  if (push.ref !== push.defaultBranch) return { ignored: `not the default branch (${push.ref} != ${push.defaultBranch})` };
  return { build: push };
}
