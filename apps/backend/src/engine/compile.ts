import { nodeKey, parseSource, type SourceLines } from './syntax.js';
import { validateGraph, type LoopGraph } from './graph.js';
import type { AgentDefinition } from './agent.js';

export interface CompileProblem {
  severity: 'error' | 'warning';
  message: string;
  line?: number | undefined;
}

export interface Known {
  tools?: Set<string> | undefined;
  agents?: Set<string> | undefined;
  loops?: Set<string> | undefined;
}

export interface Compiled {
  ok: boolean;
  loops: LoopGraph[];
  agents: AgentDefinition[];
  problems: CompileProblem[];
}

function checkAgent(
  agent: AgentDefinition,
  known: Known,
  loopIds: Set<string>,
  at: SourceLines,
): CompileProblem[] {
  const line = at.agent[agent.slug];
  const found: CompileProblem[] = [];
  const say = (message: string) => found.push({ severity: 'error', message, line });

  if (!agent.slug) say('this agent has no name');
  if (!agent.loop) say(`agent "${agent.slug}" does not say which loop it runs`);
  else if (!loopIds.has(agent.loop) && known.loops && !known.loops.has(agent.loop)) {
    say(`agent "${agent.slug}" runs loop "${agent.loop}", which does not exist`);
  }

  for (const tool of agent.tools) {
    if (known.tools && !known.tools.has(tool)) {
      say(`agent "${agent.slug}" is granted "${tool}", which is not a tool`);
    }
  }

  for (const callee of agent.agents ?? []) {
    if (callee === agent.slug) say(`agent "${agent.slug}" may not call itself`);
    else if (known.agents && !known.agents.has(callee)) {
      say(`agent "${agent.slug}" may call "${callee}", which is not an agent`);
    }
  }

  return found;
}

export function compile(source: string, known: Known = {}): Compiled {
  const parsed = parseSource(source);

  const problems: CompileProblem[] = parsed.problems.map((problem) => ({
    severity: 'error',
    message: problem.message,
    line: problem.line,
  }));

  const loopIds = new Set(parsed.loops.map((loop) => loop.id));
  const agentIds = new Set([
    ...(known.agents ?? []),
    ...parsed.agents.map((agent) => agent.slug),
  ]);

  const seenLoops = new Set<string>();
  for (const loop of parsed.loops) {
    if (seenLoops.has(loop.id)) {
      problems.push({
        severity: 'error',
        message: `two loops are called "${loop.id}"`,
        line: parsed.lines.loop[loop.id],
      });
    }
    seenLoops.add(loop.id);

    const scope = { ...(known.tools ? { tools: known.tools } : {}), agents: agentIds };

    for (const problem of validateGraph(loop, scope)) {
      problems.push({
        severity: problem.severity,
        message: problem.message,
        line: problem.nodeId
          ? parsed.lines.node[nodeKey(loop.id, problem.nodeId)] ?? parsed.lines.loop[loop.id]
          : parsed.lines.loop[loop.id],
      });
    }
  }

  const seenAgents = new Set<string>();
  for (const agent of parsed.agents) {
    if (seenAgents.has(agent.slug)) {
      problems.push({
        severity: 'error',
        message: `two agents are called "${agent.slug}"`,
        line: parsed.lines.agent[agent.slug],
      });
    }
    seenAgents.add(agent.slug);
    problems.push(...checkAgent(agent, { ...known, agents: agentIds }, loopIds, parsed.lines));
  }

  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  return {
    ok: !problems.some((problem) => problem.severity === 'error'),
    loops: parsed.loops,
    agents: parsed.agents,
    problems,
  };
}

export function formatProblems(problems: readonly CompileProblem[]): string {
  if (problems.length === 0) return '';

  return problems
    .map((problem) => {
      const where = problem.line === undefined ? '' : `line ${problem.line}: `;
      const mark = problem.severity === 'warning' ? 'warning: ' : '';
      return `${where}${mark}${problem.message}`;
    })
    .join('\n');
}
