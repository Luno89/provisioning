import type { AcceptanceCheck } from './acceptance.js';

const ALWAYS_TRUE = /^(echo\b|printf\b|true$|:$|exit\s+0$|cd\s+\S+$|ls$|pwd$|sleep\s+\d+$)/;

export function cannotFail(command: string): string | undefined {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return 'is empty';

  const links = trimmed.split('&&').map((s) => s.trim()).filter(Boolean);
  const last = links[links.length - 1] ?? trimmed;

  if (ALWAYS_TRUE.test(last)) {
    return links.length > 1
      ? `ends in \`${last}\`, so it exits 0 even when the earlier commands fail`
      : `is \`${last}\`, which always exits 0`;
  }
  if (/\|\|\s*(true|:)\s*$/.test(trimmed)) return 'ends in `|| true`, which discards any failure';
  return undefined;
}

export interface CheckVerdict {
  name: string;
  command: string;
  reason: string;
}

export function hollowChecks(plan: readonly AcceptanceCheck[]): CheckVerdict[] {
  const out: CheckVerdict[] = [];
  for (const check of plan) {
    const reason = cannotFail(check.command);
    if (reason) out.push({ name: check.name, command: check.command, reason });
  }
  return out;
}

export function explainHollow(verdicts: readonly CheckVerdict[]): string {
  const lines = verdicts.map((v) => `  · "${v.name}": \`${v.command}\` ${v.reason}`);
  return (
    `${verdicts.length === 1 ? 'This check cannot fail' : 'These checks cannot fail'}, so running `
    + `${verdicts.length === 1 ? 'it' : 'them'} proves nothing:\n${lines.join('\n')}\n`
    + 'A check must exit non-zero when the thing is broken. Run the code and let its own exit '
    + 'status decide — call the service and check the response, run the test suite, execute the '
    + 'entry point with real arguments. Do not append `echo`, and do not end with `|| true`.'
  );
}
