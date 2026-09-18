import type { ToolDefinition } from '@koala/agent-engine';

export interface Attempt {
  toolCalls: { name: string; arguments: string }[];
  content: string;
}

export type ArgCheck =
  | { arg: string; is: string }
  | { arg: string; contains: string }
  | { arg: string; matches: string }
  | { arg: string; nonEmpty: true };

export interface Expectation {
  tool: string | null;
  args?: ArgCheck[] | undefined;
}

export interface Verdict {
  passed: boolean;
  complaint?: string | undefined;
}

const PASS: Verdict = { passed: true };

const fail = (complaint: string): Verdict => ({ passed: false, complaint });

const clip = (text: string, max = 120): string =>
  (text.length <= max ? text : `${text.slice(0, max)}…`);

function checkArg(check: ArgCheck, value: unknown): string | undefined {
  if (value === undefined) return `sent no "${check.arg}"`;

  const text = typeof value === 'string' ? value : JSON.stringify(value);

  if ('is' in check) {
    if (text === check.is) return undefined;
    const isBoolCheck = check.is.toLowerCase() === 'true' || check.is.toLowerCase() === 'false';
    if (isBoolCheck && text.toLowerCase() === check.is.toLowerCase()) {
      return undefined;
    }
    return `sent "${check.arg}" as ${clip(text, 60)}, wanted ${check.is}`;
  }
  if ('contains' in check) {
    return text.includes(check.contains)
      ? undefined
      : `"${check.arg}" does not contain ${JSON.stringify(check.contains)}: ${clip(text, 80)}`;
  }
  if ('matches' in check) {
    return new RegExp(check.matches).test(text)
      ? undefined
      : `"${check.arg}" does not match /${check.matches}/: ${clip(text, 80)}`;
  }
  return text.trim() ? undefined : `sent "${check.arg}" empty`;
}

export function scoreAttempt(
  attempt: Attempt,
  expect: Expectation,
  tool?: ToolDefinition | undefined,
): Verdict {
  const called = attempt.toolCalls.map((made) => made.name);

  if (expect.tool === null) {
    if (called.length > 0) {
      return fail(`called ${called.join(', ')} when it should have called nothing and answered`);
    }
    return attempt.content.trim()
      ? PASS
      : fail('called nothing and answered nothing — it did not decline, it produced nothing');
  }

  if (attempt.toolCalls.length === 0) {
    const said = attempt.content.trim();
    return fail(said
      ? `called no tool, answered instead: "${clip(said)}"`
      : 'called no tool and said nothing');
  }

  const call = attempt.toolCalls.find((made) => made.name === expect.tool);
  if (!call) return fail(`called ${called.join(', ')} instead of ${expect.tool}`);

  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() ? JSON.parse(call.arguments) as Record<string, unknown> : {};
  } catch {
    return fail(`arguments for ${expect.tool} were not valid JSON: ${clip(call.arguments)}`);
  }

  const required = tool?.parameters.required ?? [];
  const known = new Set(Object.keys(tool?.parameters.properties ?? {}));

  const missing = required.filter((name) => args[name] === undefined);
  if (missing.length > 0) {
    const sent = Object.keys(args).join(', ') || 'nothing';
    return fail(`called ${expect.tool} without ${missing.join(', ')} (sent ${sent})`);
  }

  if (known.size > 0) {
    const invented = Object.keys(args).filter((name) => !known.has(name));
    if (invented.length > 0) {
      return fail(`invented arguments ${invented.join(', ')} — the schema offers ${[...known].join(', ')}`);
    }
  }

  for (const check of expect.args ?? []) {
    const complaint = checkArg(check, args[check.arg]);
    if (complaint) return fail(`${expect.tool} ${complaint}`);
  }

  return PASS;
}

export interface CaseOutcome {
  name: string;
  category: string;
  attempts: number;
  passed: number;
  complaints: string[];
}

export function summarise(outcomes: readonly CaseOutcome[]): string {
  if (outcomes.length === 0) return 'no cases ran';

  const width = Math.max(...outcomes.map((outcome) => outcome.name.length));

  const lines = outcomes.map((outcome) => {
    const mark = outcome.passed === outcome.attempts
      ? 'pass '
      : outcome.passed === 0 ? 'FAIL ' : 'flaky';

    const head = `  ${mark} ${outcome.name.padEnd(width)}  ${outcome.passed}/${outcome.attempts}`;
    const why = [...new Set(outcome.complaints)].map((complaint) => `\n         ${complaint}`);

    return head + why.join('');
  });

  const attempts = outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0);
  const passed = outcomes.reduce((sum, outcome) => sum + outcome.passed, 0);
  const reliable = outcomes.filter((outcome) => outcome.passed === outcome.attempts).length;

  return [
    ...lines,
    '',
    `  ${reliable}/${outcomes.length} cases passed every time · ${passed}/${attempts} attempts`,
  ].join('\n');
}

export interface ToolScore {
  tool: string;
  cases: number;
  attempts: number;
  passed: number;
  complaints: string[];
}

export function byTool(
  cases: readonly { name: string; expect: { tool: string | null } }[],
  outcomes: readonly CaseOutcome[],
): ToolScore[] {
  const wanted = new Map(cases.map((entry) => [entry.name, entry.expect.tool]));
  const scores = new Map<string, ToolScore>();

  for (const outcome of outcomes) {
    const tool = wanted.get(outcome.name) ?? null;
    const key = tool ?? '(answers without calling anything)';

    const score = scores.get(key) ?? { tool: key, cases: 0, attempts: 0, passed: 0, complaints: [] };
    score.cases += 1;
    score.attempts += outcome.attempts;
    score.passed += outcome.passed;
    score.complaints.push(...outcome.complaints);
    scores.set(key, score);
  }

  return [...scores.values()]
    .map((score) => ({ ...score, complaints: [...new Set(score.complaints)] }))
    .sort((a, b) => (a.passed / a.attempts) - (b.passed / b.attempts) || a.tool.localeCompare(b.tool));
}
