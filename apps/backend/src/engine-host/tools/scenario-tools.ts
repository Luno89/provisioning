import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { ToolDefinition } from '@koala/agent-engine';
import { scenarioProblems } from '../../eval/level2/scenario.js';
import { proposedScenario, type ScenarioProposal } from '../../lib/scenario-proposals.js';

export interface ScenarioProposalAccess {
  known(ownerId: string): Promise<{ agents: ReadonlySet<string>; procedures: ReadonlySet<string>; tools: readonly ToolDefinition[] }>;
  procedureOf(ownerId: string, agent: string): Promise<string | undefined>;
  scenarioIds(ownerId: string): Promise<string[]>;
  proposals: {
    list(ownerId: string): Promise<ScenarioProposal[]>;
    save(proposal: ScenarioProposal): Promise<void>;
  };
  now?: (() => string) | undefined;
}

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

const text = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const names = (value: unknown): string[] | undefined => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : undefined;
  const clean = list?.map((entry) => String(entry).trim()).filter(Boolean);
  return clean?.length ? clean : undefined;
};

export function createScenarioTools(access: ScenarioProposalAccess): Record<string, ToolHandler> {
  const now = access.now ?? (() => new Date().toISOString());
  return {
    async propose_scenario({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to propose a test to');
      const agent = text(parsed, 'agent');
      const name = text(parsed, 'name');
      const checks = text(parsed, 'checks');
      const message = text(parsed, 'message');
      const why = text(parsed, 'why');
      if (!agent || !name || !checks || !message || !why) return refuse('give the agent, a name, what a correct run does, the message that reproduces it, and why');

      const procedure = await access.procedureOf(ownerId, agent);
      if (!procedure) return refuse(`there is no agent called "${agent}"`);
      const scenario = proposedScenario({
        agent, procedure, name, checks, message,
        expect: {
          ...(text(parsed, 'outcome') ? { outcome: text(parsed, 'outcome') } : {}),
          ...(names(parsed.toolsCalled) ? { toolsCalled: names(parsed.toolsCalled) } : {}),
          ...(names(parsed.toolsNotCalled) ? { toolsNotCalled: names(parsed.toolsNotCalled) } : {}),
          ...(names(parsed.toolsInOrder) ? { toolsInOrder: names(parsed.toolsInOrder) } : {}),
        },
      });

      const problems = scenarioProblems(scenario, await access.known(ownerId));
      if (problems.length > 0) return refuse(`not proposed: ${problems.join('; ')}`);
      if ((await access.scenarioIds(ownerId)).includes(scenario.id)) return refuse(`there is already a scenario ${scenario.id}; nothing was proposed`);
      if ((await access.proposals.list(ownerId)).some((proposal) => proposal.status === 'proposed' && proposal.scenario.id === scenario.id)) {
        return refuse(`${scenario.id} is already waiting for the person; nothing was proposed`);
      }

      await access.proposals.save({
        id: scenario.id,
        ownerId,
        scenario,
        why,
        status: 'proposed',
        ...(caller.runId ? { proposedBy: caller.runId } : {}),
        createdAt: now(),
      });
      return { ok: true, digest: `proposed ${scenario.id}`, content: `Proposed the test ${scenario.id}; it waits for the person to accept it.` };
    },
  };
}
