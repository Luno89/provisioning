import type { WorkspaceLanguage } from './workspace-spec.js';

const SENTINEL = 'KOALA_VERIFY_EXIT';

export type VerifyOutcome =
  | 'passed'
  | 'failed'
  | 'unverified';

export interface VerifyResult {
  outcome: VerifyOutcome;
  output: string;
}

export function evidenceOf(
  outcome: VerifyOutcome,
  { declaredCommand, changed }: { declaredCommand: boolean; changed: boolean },
): VerifyOutcome {
  if (outcome !== 'passed') return outcome;
  if (declaredCommand || changed) return outcome;
  return 'unverified';
}

export function defaultVerifyCommand(language: WorkspaceLanguage | undefined): string | undefined {
  switch (language ?? 'node') {
    case 'node':
      return 'node --test $(ls test/*.test.js 2>/dev/null; ls *.test.js 2>/dev/null)';
    case 'python':
      return 'python -m unittest discover -v';
    case 'go':
      return 'go test ./...';
    default:
      return undefined;
  }
}

export function buildVerifyScript(command: string, language: WorkspaceLanguage | undefined): string {
  const guard = (language ?? 'node') === 'node'
    ? 'ls test/*.test.js >/dev/null 2>&1 || ls *.test.js >/dev/null 2>&1 || { echo "' + SENTINEL + '=127"; exit 0; }'
    : '';

  return [
    'cd /work/repo 2>/dev/null || cd /work || exit 0',
    ...(guard ? [guard] : []),
    `${command} 2>&1 | tail -60`,
    `echo "${SENTINEL}=\${PIPESTATUS[0]:-$?}"`,
  ].join('\n');
}

export function parseVerifyResult(stdout: string): VerifyResult {
  const match = new RegExp(`${SENTINEL}=(\\d+)`).exec(stdout);
  const output = stdout.replace(new RegExp(`${SENTINEL}=\\d+\\s*$`), '').trim().slice(-2000);

  if (!match) return { outcome: 'unverified', output };

  const code = Number(match[1]);
  if (code === 127) return { outcome: 'unverified', output };
  return { outcome: code === 0 ? 'passed' : 'failed', output };
}

export function decideStatus(claimed: boolean, verify: VerifyOutcome): 'succeeded' | 'failed' {
  if (verify === 'passed') return 'succeeded';
  if (verify === 'failed') return 'failed';
  return claimed ? 'succeeded' : 'failed';
}
