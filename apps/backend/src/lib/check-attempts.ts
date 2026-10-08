import type { ScenarioResult, CheckAttempt } from '../eval/level2/results.js';

export const attemptOf = (result: ScenarioResult): CheckAttempt => ({
  runId: result.runId,
  ...(result.conversationId ? { conversationId: result.conversationId } : {}),
  passed: result.passed,
  durationMs: result.durationMs,
  checks: result.checks,
  calls: result.calls,
  ...(result.error ? { error: result.error } : {}),
});

export function combineAttempts(results: readonly ScenarioResult[], passAt: number): ScenarioResult {
  const first = results[0];
  if (!first) throw new Error('a repeated check needs at least one attempt');
  const passedAttempts = results.filter((result) => result.passed).length;
  const shown = results.find((result) => !result.passed) ?? results.at(-1)!;

  const lines = new Map<string, { passed: number; seen: number; complaints: string[] }>();
  for (const result of results) {
    for (const check of result.checks) {
      const line = lines.get(check.what) ?? { passed: 0, seen: 0, complaints: [] };
      line.seen += 1;
      if (check.passed) line.passed += 1;
      else if (!line.complaints.includes(check.detail)) line.complaints.push(check.detail);
      lines.set(check.what, line);
    }
  }
  const total = results.length;
  const passed = passedAttempts >= passAt;
  const errors = [...new Set(results.flatMap((result) => (result.error ? [result.error] : [])))];

  return {
    ...shown,
    passed,
    checks: [
      {
        what: passAt === total ? `passes all ${total} times` : `passes at least ${passAt} of ${total} times`,
        passed,
        detail: `${passedAttempts} of ${total} passed${errors.length ? `; ${errors.length === 1 ? 'one broke' : 'some broke'}: ${errors.join('; ').slice(0, 300)}` : ''}`,
      },
      ...[...lines.entries()].map(([what, line]) => ({
        what: `${what} — ${line.passed}/${line.seen}`,
        passed: line.passed === line.seen,
        detail: line.complaints.length ? line.complaints.join(' · ').slice(0, 600) : 'every time',
      })),
    ],
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    repeats: total,
    passAt,
    passedAttempts,
    attempts: results.map(attemptOf),
    ...(results.every((result) => result.error) ? { error: errors[0] } : { error: undefined }),
  };
}
