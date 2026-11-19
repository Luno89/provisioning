import { createHash } from 'node:crypto';

const LABEL_LIMIT = 63;
const ENDING = '-state';

// ── DUPLICATED, KNOWINGLY ── packages/cdktf-infra/lib/state.ts wins (stateSecretSuffix); state-secret.test.ts holds this to the names it gives.
export function stateSecretSuffix(stackId: string): string {
  const plain = stackId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (plain === stackId && plain.length + ENDING.length <= LABEL_LIMIT) return `${plain}${ENDING}`;
  const hash = createHash('sha256').update(stackId).digest('hex').slice(0, 8);
  const kept = plain.slice(0, LABEL_LIMIT - ENDING.length - hash.length - 1).replace(/-+$/, '');
  return `${kept ? `${kept}-` : ''}${hash}${ENDING}`;
}

export const stateSecretName = (stackId: string): string => `tfstate-default-${stateSecretSuffix(stackId)}`;
