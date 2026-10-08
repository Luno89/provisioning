import type { ToolDefinition } from '@koala/agent-engine';
import type { Scenario } from '../eval/level2/scenario.js';
import { scenarioSubjects } from './check-subjects.js';

export type CoverageGap =
  | { kind: 'uncovered'; tool: string; message: string }
  | { kind: 'unprovoked'; tool: string; when: string; message: string }
  | { kind: 'no-restraint'; agent: string; message: string };

type Checked = Pick<Scenario, 'agent' | 'procedure' | 'step' | 'turn' | 'expect' | 'then'>;

export function checkCoverage(tools: readonly ToolDefinition[], checks: readonly Checked[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const covered = new Set(checks.flatMap((check) => scenarioSubjects(check).tools));
  const provoked = checks.flatMap((check) => [check.expect, ...(check.then ?? []).map((stage) => stage.expect)])
    .flatMap((expect) => (expect?.provokes ? [expect.provokes] : []));

  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!covered.has(tool.name)) gaps.push({ kind: 'uncovered', tool: tool.name, message: `no check touches ${tool.name}` });
    for (const failure of tool.failures) {
      if (!provoked.some((entry) => entry.tool === tool.name && entry.when === failure.when)) {
        gaps.push({ kind: 'unprovoked', tool: tool.name, when: failure.when, message: `nothing provokes "${failure.when}", which ${tool.name} says it can fail on` });
      }
    }
  }

  const turns = checks.filter((check) => check.turn);
  for (const agent of [...new Set(turns.map((check) => check.agent))].sort()) {
    if (!turns.some((check) => check.agent === agent && check.expect.chooses?.tool === null)) {
      gaps.push({ kind: 'no-restraint', agent, message: `no turn check of ${agent} expects it to answer without a tool, so nothing checks it can leave its tools alone` });
    }
  }
  return gaps;
}
