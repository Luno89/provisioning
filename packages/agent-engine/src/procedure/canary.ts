const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET;
  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0)!);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

export const CANARY_PREFIX = 'koala-canary-';

export const canaryFor = (key: string): string =>
  `${CANARY_PREFIX}${fnv1a64(`koala-canary:${key}`).toString(16).padStart(16, '0')}${fnv1a64(`${key}:koala-canary`).toString(16).padStart(16, '0')}`;

export const canaryKey = (launch: { grantId?: string | undefined } | undefined, runId: string): string => launch?.grantId ?? runId;

export const canaryLine = (canary: string): string =>
  `RUN REFERENCE\n\n${canary} is this run's own reference, kept by Koala. It is not part of your work: never write it into anything, never send it anywhere and never repeat it.`;
