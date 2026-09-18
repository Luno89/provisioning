import type { CaseOutcome, CaseResult, EvalCase, EvalCaseSummary, Level1Run } from '../api/evals'

export function summaryOf(entry: EvalCase): EvalCaseSummary {
  return {
    name: entry.name,
    category: entry.category,
    agent: entry.agent,
    say: entry.say,
    expects: entry.expect.tool,
  }
}

export function outcomeOf(result: CaseResult): CaseOutcome {
  return {
    name: result.name,
    category: result.category,
    attempts: result.attempts.length,
    passed: result.attempts.filter((attempt) => attempt.passed).length,
    complaints: result.attempts.flatMap((attempt) => (attempt.complaint ? [attempt.complaint] : [])),
  }
}

export function outcomesOf(run: Level1Run | undefined): CaseOutcome[] {
  return (run?.results ?? []).map(outcomeOf)
}

export function promptHashes(run: Level1Run | undefined): string[] {
  const hashes = new Set<string>()
  for (const result of run?.results ?? []) {
    for (const attempt of result.attempts) if (attempt.systemHash) hashes.add(attempt.systemHash)
  }
  return [...hashes].sort()
}

export function attemptsOf(run: Level1Run | undefined, name: string): CaseResult['attempts'] {
  return run?.results.find((result) => result.name === name)?.attempts ?? []
}

export function runLabel(run: Level1Run): string {
  const when = new Date(run.startedAt).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const model = run.modelLabel ?? run.modelId ?? 'Account default'
  const temperature = run.sampling?.toolTurn?.temperature
  const reliability = run.summary?.reliability
  const standing = reliability
    ? `${reliability.always} solid, ${reliability.flaky} flaky, ${reliability.never} broken`
    : run.state

  return [
    when,
    model,
    ...(temperature === undefined ? [] : [`T=${temperature}`]),
    `${run.finished}/${run.cases.length}`,
    `(${standing})`,
  ].join(' · ')
}
