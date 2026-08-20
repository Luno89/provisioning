/**
 * Orchestrator Chat Engine for Harness V2.
 *
 * Provides conversational planning, goal deconstruction, and structured HarnessTask proposals.
 */
import { v4 as uuidv4 } from 'uuid';
import type { HarnessChatMessage, ProposedHarnessTask } from '@koala/harness-types';
import { BudgetAllocator } from './budget-allocator.js';

export interface OrchestratorReplyResult {
  message: HarnessChatMessage;
  proposals: ProposedHarnessTask[];
}

export class OrchestratorChat {
  /**
   * Processes a new user prompt in the Harness V2 conversation context.
   */
  static async processMessage(
    userText: string,
    history: HarnessChatMessage[] = [],
  ): Promise<OrchestratorReplyResult> {
    const trimmed = userText.trim();
    const proposals: ProposedHarnessTask[] = [];

    const isTaskRequest = /^(implement|build|create|add|fix|refactor|research|investigate|audit)\b/i.test(trimmed)
      || trimmed.includes('can we')
      || trimmed.includes('task');

    let reasoning = `Analyzing user request: "${trimmed}".`;
    let content = '';

    if (isTaskRequest) {
      reasoning += ` Identified clear actionable objective. Constructing structured Harness V2 Task Proposal with dynamic budget and rubrics.`;

      const title = trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed;
      const budget = BudgetAllocator.estimateBudget(title, trimmed);
      const isResearch = trimmed.toLowerCase().includes('research') || trimmed.toLowerCase().includes('investigate');

      const proposal: ProposedHarnessTask = {
        id: `prop-${uuidv4().slice(0, 8)}`,
        title,
        description: trimmed,
        personaId: isResearch ? 'researcher' : 'coder',
        budget,
        rubrics: isResearch
          ? [
              { name: 'evidence_and_citations', weight: 0.5, description: 'Primary sources and repository evidence verified.' },
              { name: 'actionability', weight: 0.5, description: 'Concrete recommendations and trade-offs presented.' },
            ]
          : [
              { name: 'test_pass_rate', weight: 0.4, description: 'All unit and integration tests pass with 0 errors.' },
              { name: 'code_completeness', weight: 0.3, description: 'No dummy stubs or unfinished placeholders.' },
              { name: 'specification_fidelity', weight: 0.3, description: 'Fulfills all requirements specified in scope.' },
            ],
        status: 'proposed',
        createdAt: new Date().toISOString(),
      };

      proposals.push(proposal);

      content = [
        `I've analyzed your goal and prepared a dedicated Harness V2 task proposal.`,
        ``,
        `• **Assigned Persona**: \`${proposal.personaId}\``,
        `• **Dynamic Budget**: ${proposal.budget.maxTurns} turns (~${proposal.budget.maxTokens.toLocaleString()} tokens)`,
        `• **Evaluation Strategy**: ${isResearch ? 'Evidence & Actionability Judge' : 'Automated Tests + Completeness Rubric'}`,
        ``,
        `You can review the proposal below and launch it into our durable Temporal execution engine whenever you're ready.`,
      ].join('\n');
    } else {
      reasoning += ` Open-ended conversational query. Providing architectural guidance.`;
      content = `I'm ready to help you plan or build. You can describe a feature, bugfix, or research goal, and I'll deconstruct it into a durable, rubric-evaluated Harness V2 task.`;
    }

    const assistantMsg: HarnessChatMessage = {
      id: `msg-${uuidv4().slice(0, 8)}`,
      role: 'assistant',
      content,
      reasoning,
      proposals: proposals.length > 0 ? proposals : undefined,
      createdAt: new Date().toISOString(),
    };

    return {
      message: assistantMsg,
      proposals,
    };
  }
}
