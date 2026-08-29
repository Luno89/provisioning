
export const NUDGE_AFTER = 12;

export const STOP_AFTER = 20;

const MUTATING = [
  />{1,2}\s*(?!\/dev\/null)/,
  /\btee\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bcp\b|\bmv\b|\brm\b/,
  /\bsed\s+-i\b/,
  /\bgit\s+(commit|apply|cherry-pick|revert|merge|push)\b/,
  /\bpatch\b/,
  /\bnpm\s+init\b/,
];

export function isProductive(calls: { name: string; arguments: string }[]): boolean {
  for (const call of calls) {
    if (call.name === 'write_file') return true;
    if (call.name !== 'run_command') continue;
    let command = call.arguments;
    try {
      command = String(JSON.parse(call.arguments)?.command ?? call.arguments);
    } catch { /* ignored */ }
    if (MUTATING.some((pattern) => pattern.test(command))) return true;
  }
  return false;
}

export type ThrashAction = 'continue' | 'nudge' | 'stop';

export function thrashAction(unproductiveTurns: number): ThrashAction {
  if (unproductiveTurns >= STOP_AFTER) return 'stop';
  if (unproductiveTurns === NUDGE_AFTER) return 'nudge';
  return 'continue';
}

export function nudgeMessage(unproductiveTurns: number, recentCommands: string[]): string {
  const recent = recentCommands.slice(-3).map((c) => `\`${c.slice(0, 80)}\``).join(', ');
  return [
    `You have taken ${unproductiveTurns} turns without creating or changing a single file.`,
    recent ? `The last things you ran were ${recent} — all of them inspect, none of them produce.` : '',
    'Stop looking. Write the file you were asked for now, with write_file, even if it is imperfect;',
    'you can correct it afterwards. If you genuinely cannot, call finish and say what is blocking you.',
  ].filter(Boolean).join(' ');
}

export function thrashSummary(unproductiveTurns: number, recentCommands: string[]): string {
  return `Stopped after ${unproductiveTurns} turns that produced nothing — the agent inspected the `
    + `workspace repeatedly and never created or changed a file. This is not a budget problem: the `
    + `remaining steps were left unspent because more of the same would not have helped. `
    + `Last commands: ${recentCommands.slice(-3).join(' | ') || 'none'}`;
}
