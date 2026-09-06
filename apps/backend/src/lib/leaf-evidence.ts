import type { LeafEvidence } from './leaf-trace.js';

export const MAX_DIFF_CHARS = 12_000;
export const MAX_EXPECT_FILES = 5;
export const MAX_EXPECT_CHARS = 4_000;

export const NOISE_DIR_NAMES = ['node_modules', 'vendor', '.venv', 'venv', 'dist', 'build', '__pycache__', '.koala'] as const;

const NOISE = new RegExp(`^(${NOISE_DIR_NAMES.join('|').replace(/\./g, '\\.')})/|(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|poetry\\.lock|Cargo\\.lock|go\\.sum)$`);

export interface CaptureInputs {
  workspaces: {
    exec(id: string, script: string, timeoutMs?: number, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    readFile(id: string, path: string): Promise<string>;
  };
  leafId: string;
  base?: string | undefined;
  expects?: string[] | undefined;
  verifyOutput?: string | undefined;
  findings?: string | undefined;
}

export function buildDiffScript(): string {
  return [
    'cd /work/repo 2>/dev/null || exit 0',
    'echo "STAT:"',
    'git diff --stat "origin/$0..HEAD" 2>/dev/null || git diff --stat HEAD 2>/dev/null || true',
    'echo "PATCH:"',
    'git diff --no-color --unified=3 "origin/$0..HEAD" 2>/dev/null || git diff --no-color --unified=3 HEAD 2>/dev/null || true',
  ].join('\n');
}

export function trimDiff(raw: string, budget = MAX_DIFF_CHARS): { diff: string; truncated: boolean } {
  const [statPart = '', patchPart = ''] = raw.split('PATCH:');
  const stat = statPart.replace(/^STAT:\s*/, '').trim();

  const files = patchPart.split(/^(?=diff --git )/m).filter((f) => f.trim());
  const kept: string[] = [];
  let used = stat.length;
  let dropped = 0;

  for (const file of files) {
    const path = /^diff --git a\/(\S+)/.exec(file)?.[1] ?? '';
    if (path && NOISE.test(path)) { dropped++; continue; }
    if (used + file.length > budget) { dropped++; continue; }
    kept.push(file.trimEnd());
    used += file.length;
  }

  const parts = [stat, ...kept].filter(Boolean);
  if (dropped > 0) {
    parts.push(`[${dropped} more changed file(s) not shown — lockfiles, vendored paths, or beyond the size budget]`);
  }
  return { diff: parts.join('\n\n'), truncated: dropped > 0 };
}

export async function captureEvidence(inputs: CaptureInputs): Promise<LeafEvidence> {
  const evidence: LeafEvidence = { capturedAt: new Date().toISOString() };

  if (inputs.base) {
    const raw = await inputs.workspaces
      .exec(inputs.leafId, buildDiffScript(), 60_000, [inputs.base])
      .then((r) => r.stdout)
      .catch(() => '');
    if (raw.trim()) {
      const { diff, truncated } = trimDiff(raw);
      if (diff) {
        evidence.diff = diff;
        if (truncated) evidence.diffTruncated = true;
      }
    }
  }

  if (inputs.expects?.length) {
    const files: NonNullable<LeafEvidence['expects']> = [];
    for (const path of inputs.expects.slice(0, MAX_EXPECT_FILES)) {
      const full = path.startsWith('/') ? path : `/work/repo/${path}`;
      const content = await inputs.workspaces.readFile(inputs.leafId, full).catch(() => '');
      if (!content) continue;
      files.push({
        path,
        content: content.slice(0, MAX_EXPECT_CHARS),
        ...(content.length > MAX_EXPECT_CHARS ? { truncated: true } : {}),
      });
    }
    if (files.length) evidence.expects = files;
  }

  if (inputs.verifyOutput?.trim()) evidence.verifyOutput = inputs.verifyOutput;
  if (inputs.findings?.trim()) evidence.findings = inputs.findings;

  return evidence;
}
