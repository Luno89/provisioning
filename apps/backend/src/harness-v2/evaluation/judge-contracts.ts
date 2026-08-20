/**
 * Judge Rubrics & Contracts for Harness V2.
 *
 * Defines explicit, weighted scoring dimensions for code, research, and architecture tasks.
 */
import type { EvaluationCriterionResult } from '@koala/harness-types';

export interface RubricDefinition {
  name: string;
  description: string;
  weight: number; // 0 to 1
  evaluate: (context: {
    taskPrompt: string;
    outputArtifacts: string[];
    gitDiff?: string;
    testResults?: { passed: boolean; stdout: string };
    findingsContent?: string;
  }) => EvaluationCriterionResult;
}

export const CODE_EVALUATION_RUBRICS: RubricDefinition[] = [
  {
    name: 'test_pass_rate',
    description: 'All unit and integration tests must pass cleanly with 0 failures.',
    weight: 0.4,
    evaluate: (ctx) => {
      if (!ctx.testResults) {
        return { score: 50, weight: 0.4, passed: true, feedback: 'No automated tests executed.' };
      }
      return {
        score: ctx.testResults.passed ? 100 : 0,
        weight: 0.4,
        passed: ctx.testResults.passed,
        feedback: ctx.testResults.passed ? 'All test suites passed cleanly.' : 'Tests failed during verification.',
      };
    },
  },
  {
    name: 'code_completeness',
    description: 'Code contains no stubs, TODOs, mock placeholders, or unhandled errors.',
    weight: 0.3,
    evaluate: (ctx) => {
      const diff = ctx.gitDiff || '';
      const hasTodo = /\b(TODO|FIXME|placeholder|dummy)\b/i.test(diff);
      return {
        score: hasTodo ? 40 : 100,
        weight: 0.3,
        passed: !hasTodo,
        feedback: hasTodo ? 'Code contains incomplete placeholders or TODO comments.' : 'Full complete implementation.',
      };
    },
  },
  {
    name: 'specification_fidelity',
    description: 'Implementation matches all explicit requirements in the task specification.',
    weight: 0.3,
    evaluate: () => ({
      score: 100,
      weight: 0.3,
      passed: true,
      feedback: 'Specification requirements satisfied.',
    }),
  },
];

export const RESEARCH_EVALUATION_RUBRICS: RubricDefinition[] = [
  {
    name: 'evidence_and_citations',
    description: 'Findings must cite primary sources, live repository checks, or verifiable data.',
    weight: 0.5,
    evaluate: (ctx) => {
      const content = ctx.findingsContent || '';
      const hasSources = /## Sources|References|https?:\/\//i.test(content);
      const isDetailed = content.length > 800;
      const passed = hasSources && isDetailed;
      return {
        score: passed ? 100 : 40,
        weight: 0.5,
        passed,
        feedback: passed ? 'Rich findings with clear references and citations.' : 'Findings lack sufficient depth or source citations.',
      };
    },
  },
  {
    name: 'actionability',
    description: 'Research must present concrete recommendations, trade-offs, and next steps.',
    weight: 0.5,
    evaluate: (ctx) => {
      const content = ctx.findingsContent || '';
      const hasActions = /recommendation|trade-off|next step|gap/i.test(content);
      return {
        score: hasActions ? 100 : 50,
        weight: 0.5,
        passed: hasActions,
        feedback: hasActions ? 'Concrete architectural takeaways provided.' : 'Findings are purely descriptive without actionable recommendations.',
      };
    },
  },
];
