
import { extensionVariants, type FileConventions } from './tree-type-conventions.js';

const SENTINEL = 'KOALA_ARTIFACTS';

export function usablePaths(paths: string[]): string[] {
  return paths
    .map((p) => p.trim())
    .filter((p) => p
      && p.length <= 200
      && /^[A-Za-z0-9._/-]+$/.test(p)
      && !p.startsWith('/')
      && !p.split('/').includes('..'));
}

export function buildArtifactCheckScript(
  paths: string[],
  defaultBranch = 'main',
  conventions?: FileConventions | undefined,
): string {
  const safe = usablePaths(paths);
  if (safe.length === 0) return `echo "${SENTINEL}=none"`;
  const base = /^[A-Za-z0-9._/-]+$/.test(defaultBranch) ? defaultBranch : 'main';

  return [
    'cd /work/repo 2>/dev/null || cd /work || exit 0',
    'MISSING=""; STALE=""; MOVED=""',
    `BASE=""; git rev-parse --verify --quiet "origin/${base}" >/dev/null 2>&1 && BASE="origin/${base}"`,
    ...safe.flatMap((p) => {
      const bn = p.split('/').pop() ?? p;
      const variants = usablePaths(conventions ? extensionVariants(p, conventions) : [])
        .map((v) => v.split('/').pop() ?? v);
      const names = [bn, ...variants.filter((v) => v !== bn)];
      const globs = names.flatMap((n) => [`"*/${n}"`, `"${n}"`]).join(' ');
      return [
        `if [ -n "$(git ls-files -- "${p}" 2>/dev/null)" ]; then`,
        `  if [ ! -s "${p}" ]; then MISSING="$MISSING ${p}(empty)"`,
        `  elif [ -n "$BASE" ] && git diff --quiet "$BASE" -- "${p}" 2>/dev/null; then STALE="$STALE ${p}"`,
        '  fi',
        'else',
        `  BN_FOUND=""`,
        `  for CAND in $(git ls-files -- ${globs} 2>/dev/null | head -20); do`,
        '    if [ -s "$CAND" ] && { [ -z "$BASE" ] || ! git diff --quiet "$BASE" -- "$CAND" 2>/dev/null; }; then',
        '      BN_FOUND="$CAND"; break',
        '    fi',
        '  done',
        `  if [ -n "$BN_FOUND" ]; then MOVED="$MOVED ${p}->$BN_FOUND"; else MISSING="$MISSING ${p}(uncommitted)"; fi`,
        'fi',
      ];
    }),
    'if [ -n "$MOVED" ]; then echo "' + SENTINEL + '_MOVED=$MOVED"; fi',
    `if [ -n "$MISSING" ]; then echo "${SENTINEL}=missing$MISSING"`,
    `elif [ -n "$STALE" ]; then echo "${SENTINEL}=stale$STALE"`,
    `else echo "${SENTINEL}=present"; fi`,
  ].join('\n');
}

export type ArtifactOutcome = 'present' | 'missing' | 'stale' | 'none' | 'unknown';

export interface ArtifactResult {
  outcome: ArtifactOutcome;
  missing: string[];
  moved: string[];
}

export function parseArtifactResult(stdout: string): ArtifactResult {
  const movedMatch = new RegExp(`${SENTINEL}_MOVED(.*)`).exec(stdout);
  const moved = (movedMatch?.[1] ?? '').replace(/^=/, '').trim().split(/\s+/).filter(Boolean);

  if (new RegExp(`${SENTINEL}=present`).test(stdout)) return { outcome: 'present', missing: [], moved };
  if (new RegExp(`${SENTINEL}=none`).test(stdout)) return { outcome: 'none', missing: [], moved };

  const stale = new RegExp(`${SENTINEL}=stale(.*)`).exec(stdout);
  if (stale) {
    return { outcome: 'stale', missing: (stale[1] ?? '').trim().split(/\s+/).filter(Boolean), moved };
  }

  const match = new RegExp(`${SENTINEL}=missing(.*)`).exec(stdout);
  if (!match) return { outcome: 'unknown', missing: [], moved };

  return { outcome: 'missing', missing: (match[1] ?? '').trim().split(/\s+/).filter(Boolean), moved };
}

export function combineVerification(
  tests: 'passed' | 'failed' | 'unverified',
  artifacts: ArtifactOutcome,
): 'passed' | 'failed' | 'unverified' {
  if (tests === 'failed' || artifacts === 'missing') return 'failed';
  if (tests === 'passed' || artifacts === 'present') return 'passed';
  return 'unverified';
}
