/**
 * Dynamic Budget Allocator for Harness V2.
 *
 * Eliminates hardcoded step and token ceilings by estimating complexity from the task specification
 * and allowing adaptive milestone extensions.
 */
import type { HarnessBudget } from '@koala/harness-types';

export interface ComplexityFactors {
  taskLength: number;
  hasSubtasks: boolean;
  requiresTests: boolean;
  requiresResearch: boolean;
  fileCountEstimate?: number;
}

export class BudgetAllocator {
  /**
   * Estimates initial turn and token budgets based on the task description and scope.
   */
  static estimateBudget(title: string, description: string = ''): HarnessBudget {
    const combined = `${title} ${description}`.toLowerCase();
    const length = combined.length;

    let maxTurns = 12;
    let maxTokens = 40_000;

    // Complexity heuristics
    if (length > 500 || combined.includes('refactor') || combined.includes('architecture') || combined.includes('migrate')) {
      maxTurns = 30;
      maxTokens = 120_000;
    } else if (length > 200 || combined.includes('implement') || combined.includes('create service') || combined.includes('add tool')) {
      maxTurns = 20;
      maxTokens = 80_000;
    } else if (combined.includes('fix') || combined.includes('typo') || combined.includes('format')) {
      maxTurns = 8;
      maxTokens = 24_000;
    }

    return {
      maxTurns,
      turnsCompleted: 0,
      maxTokens,
      tokensUsed: 0,
      allowAdaptiveExtension: true,
    };
  }

  /**
   * Extends budget adaptively when a verifiable milestone (e.g. tests passing, sub-deliverable created) is reached.
   */
  static requestAdaptiveExtension(budget: HarnessBudget, reason: string): HarnessBudget {
    if (!budget.allowAdaptiveExtension) {
      return budget;
    }

    const additionalTurns = 10;
    const additionalTokens = 40_000;

    return {
      ...budget,
      maxTurns: budget.maxTurns + additionalTurns,
      maxTokens: budget.maxTokens + additionalTokens,
    };
  }
}
