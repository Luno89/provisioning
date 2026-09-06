import type { Leaf } from './leaves.js';
import { NOISE_DIR_NAMES } from './leaf-evidence.js';

export const REPO_MOUNT = '/work/repo';

export function inRepo(path: string): string {
  const bare = path
    .replace(new RegExp(`^${REPO_MOUNT}/+`), '')
    .replace(/^\/work\/+/, '')
    .replace(/^\/+/, '');
  return `${REPO_MOUNT}/${bare}`;
}

export const GITEA_EGRESS = { namespace: 'gitea', ports: [3000] } as const;

export const LEAF_BRANCH_PREFIX = 'koala/';

export function branchNameFor(leafId: string): string {
  return `${LEAF_BRANCH_PREFIX}${leafId.slice(0, 8)}`;
}

const WELL_FORMED = /^koala\/[a-f0-9]{8}$/;

export function baseBranchesFor(leaf: Pick<Leaf, 'dependsOn'>, all: Leaf[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of leaf.dependsOn ?? []) {
    const dep = all.find((l) => l.id === id);
    const branch = dep?.outputBranch;
    if (!branch || !WELL_FORMED.test(branch) || seen.has(branch)) continue;
    seen.add(branch);
    out.push(branch);
  }
  return out;
}

export interface CheckoutScriptOptions {
  cloneUrl: string;
  cleanUrl: string;
  branch: string;
  baseBranches: string[];
}

export function buildCheckoutScript(opts: CheckoutScriptOptions): string {
  const bases = opts.baseBranches.filter((b) => WELL_FORMED.test(b));

  return [
    'set -e',
    'git clone "$0" /work/repo',
    'cd /work/repo',
    'git config user.email koala@local',
    'git config user.name Koala',
    'git remote set-url origin "$2"',
    'git config credential.helper store',
    'printf "%s\\n" "$0" > "$HOME/.git-credentials"',
    'chmod 600 "$HOME/.git-credentials"',
    '',
    'git fetch --quiet origin "+refs/heads/*:refs/remotes/origin/*" || true',
    '',
    `STARTED=0`,
    ...(bases.length
      ? [
          `for b in ${bases.join(' ')}; do`,
          '  if ! git rev-parse --verify --quiet "origin/$b" >/dev/null; then',
          '    echo "koala: base branch $b was never pushed, skipping" >&2',
          '    continue',
          '  fi',
          '  if [ "$STARTED" = "0" ]; then',
          '    git checkout -B "$1" "origin/$b"',
          '    STARTED=1',
          '  else',
          '    if ! git merge --no-edit "origin/$b" >/dev/null 2>&1; then',
          '      git merge --abort || true',
          '      echo "koala: could not merge $b cleanly" >&2',
          '    fi',
          '  fi',
          'done',
        ]
      : []),
    'if [ "$STARTED" = "0" ]; then git checkout -b "$1"; fi',
  ].join('\n');
}

export function buildPushScript(branch: string): string {
  return [
    'cd /work/repo || exit 0',
    'if [ -n "$(git status --porcelain)" ]; then',
    '  git add -A && git commit -m "koala: work in progress" >/dev/null 2>&1 || true',
    'fi',
    'git push -u origin HEAD >/dev/null 2>&1 || true',
    `if [ -n "$(git ls-remote --heads origin "$0" 2>/dev/null)" ]; then echo "PUSHED:$0"; fi`,
  ].join('\n');
}

export function parsePushedBranch(stdout: string): string | undefined {
  const match = /^PUSHED:(\S+)$/m.exec(stdout);
  return match?.[1];
}

export function buildMergeScript(branch: string): string {
  return [
    'cd /work/repo || exit 0',
    'git fetch --quiet origin || true',
    'DEFAULT=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed "s|^origin/||")',
    '[ -n "$DEFAULT" ] || DEFAULT=main',
    'git rev-parse --verify --quiet "origin/$DEFAULT" >/dev/null || { echo "MERGE=skipped"; exit 0; }',
    'git checkout -B "__merge" "origin/$DEFAULT" >/dev/null 2>&1 || { echo "MERGE=skipped"; exit 0; }',
    'if git merge --ff-only "$0" >/dev/null 2>&1; then',
    '  :',
    'elif git merge --no-edit "$0" >/dev/null 2>&1; then',
    '  :',
    'else',
    '  git merge --abort >/dev/null 2>&1 || true',
    '  echo "MERGE=conflict"',
    '  exit 0',
    'fi',
    'if git push origin "HEAD:$DEFAULT" >/dev/null 2>&1; then echo "MERGE=merged"; else echo "MERGE=rejected"; fi',
  ].join('\n');
}

export type MergeOutcome = 'merged' | 'conflict' | 'rejected' | 'skipped';

export function parseMergeResult(stdout: string): MergeOutcome {
  const match = /MERGE=(merged|conflict|rejected|skipped)/.exec(stdout);
  return (match?.[1] as MergeOutcome) ?? 'skipped';
}

export function buildRepoStateScript(): string {
  return [
    'cd /work/repo 2>/dev/null || exit 0',
    'echo "COMMITS:"',
    'git log --oneline -5 2>/dev/null || true',
    'echo "TRACKED FILES:"',
    'git ls-files 2>/dev/null | head -40 || true',
    'echo "UNCOMMITTED:"',
    'git status --short 2>/dev/null | head -20 || true',
  ].join('\n');
}

export function summariseRepoState(stdout: string): string {
  const text = stdout.trim();
  if (!text) return '';
  const bare = text.replace(/COMMITS:|TRACKED FILES:|UNCOMMITTED:/g, '').trim();
  if (!bare) return 'The repository is still empty — nothing was committed.';
  return text.slice(0, 1500);
}

export function checkpointPath(leafId: string): string {
  return `.koala/progress-${leafId.slice(0, 8)}.md`;
}

export function buildCheckpointScript(): string {
  return [
    'cd /work/repo || exit 0',
    'if [ -n "$(git status --porcelain -- . ":(exclude).koala")" ]; then',
    '  git add -A -- . ":(exclude).koala" && git commit -m "koala: work in progress" >/dev/null 2>&1 || true',
    'fi',
    'if [ -n "$(git status --porcelain -- "$1")" ]; then',
    '  git add -- "$1" && git commit -m "koala: checkpoint" >/dev/null 2>&1 || true',
    'fi',
    'git push -u origin HEAD >/dev/null 2>&1 || true',
    'if [ -n "$(git ls-remote --heads origin "$0" 2>/dev/null)" ]; then',
    '  echo "CHECKPOINT:$0:$(git rev-parse --short HEAD 2>/dev/null || echo none)"',
    'fi',
  ].join('\n');
}

export function parseCheckpointResult(stdout: string): { branch: string; sha: string } | undefined {
  const match = /^CHECKPOINT:(\S+):(\S+)$/m.exec(stdout);
  if (!match?.[1] || !match?.[2]) return undefined;
  return { branch: match[1], sha: match[2] };
}

export function buildProgressScript(): string {
  return [
    'cd /work/repo 2>/dev/null || exit 0',
    'echo "COMMITS:"',
    'git log --oneline "origin/$0..HEAD" 2>/dev/null | head -20 || git log --oneline 2>/dev/null | head -20 || true',
    'echo "CHANGED:"',
    'git diff --stat "origin/$0..HEAD" 2>/dev/null | tail -25 || git diff --stat HEAD 2>/dev/null | tail -25 || true',
  ].join('\n');
}

export function parseProgress(stdout: string): { commits: string; changed: string } {
  const commits = /COMMITS:\n([\s\S]*?)(?:\nCHANGED:|$)/.exec(stdout)?.[1]?.trim() ?? '';
  const changed = /CHANGED:\n([\s\S]*)$/.exec(stdout)?.[1]?.trim() ?? '';
  return { commits, changed };
}

export function buildRepoDetailScript(): string {
  return [
    'cd /work/repo 2>/dev/null || exit 0',
    'echo "STATUS:"',
    'git status --porcelain 2>/dev/null || true',
    'echo "COMMITS:"',
    'git rev-list --count HEAD 2>/dev/null || true',
  ].join('\n');
}

export function parseRepoDetail(stdout: string): { commits?: number; changedFiles?: string[] } {
  const [statusPart = '', commitsPart = ''] = stdout.split('COMMITS:');
  const changedFiles = statusPart.replace(/^STATUS:/, '')
    .split('\n').filter(Boolean).map((l) => l.trim().slice(2).trim());
  const commitsText = commitsPart.trim();
  const commits = commitsText ? Number(commitsText) || 0 : undefined;

  return {
    ...(commits !== undefined ? { commits } : {}),
    ...(changedFiles.length ? { changedFiles } : {}),
  };
}

const TRACKED_FILES_IGNORE = NOISE_DIR_NAMES;

export function buildTrackedFilesScript(opts: { filterNoise?: boolean; limit?: number } = {}): string {
  const filter = opts.filterNoise
    ? ` | grep -vE '^(${TRACKED_FILES_IGNORE.join('|').replace(/\./g, '\\.')})/'`
    : '';
  const head = opts.limit ? ` | head -${opts.limit}` : '';
  return `cd /work/repo 2>/dev/null && git ls-files${filter}${head}`;
}

export function parseTrackedFiles(stdout: string): string[] {
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}
