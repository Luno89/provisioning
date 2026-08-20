/**
 * Rubric Evaluator Engine for Harness V2.
 *
 * Decouples the generator agent from a skeptical evaluation layer.
 */
import type { TaskEvaluationVerdict } from '@koala/harness-types';
import { CODE_EVALUATION_RUBRICS, RESEARCH_EVALUATION_RUBRICS, type RubricDefinition } from './judge-contracts.js';

export interface EvaluationInput {
  taskType: 'code' | 'research' | 'architecture';
  taskPrompt: string;
  outputArtifacts: string[];
  gitDiff?: string;
  testResults?: { passed: boolean; stdout: string };
  findingsContent?: string;
}

export class RubricEvaluator {
  /**
   * Evaluates a completed task across all relevant rubric dimensions.
   */
  static evaluate(input: EvaluationInput): TaskEvaluationVerdict {
    const rubrics: RubricDefinition[] = input.taskType === 'research'
      ? RESEARCH_EVALUATION_RUBRICS
      : CODE_EVALUATION_RUBRICS;

    const breakdown: Record<string, any> = {};
    let weightedScoreTotal = 0;
    let totalWeight = 0;

    for (const rubric of rubrics) {
      const result = rubric.evaluate(input);
      breakdown[rubric.name] = result;
      weightedScoreTotal += result.score * result.weight;
      totalWeight += result.weight;
    }

    const finalScore = totalWeight > 0 ? Math.round(weightedScoreTotal / totalWeight) : 0;
    const passed = finalScore >= 80;

    const evaluatorNotes = passed
      ? `Task evaluation passed with score ${finalScore}/100. All primary rubric criteria satisfied.`
      : `Task evaluation failed with score ${finalScore}/100. Deficiencies detected across rubric dimensions: ${Object.entries(breakdown).filter(([, r]: any) => !r.passed).map(([k, r]: any) => `${k} (${r.feedback})`).join(', ')}`;

    return {
      score: finalScore,
      passed,
      rubricBreakdown: breakdown,
      evaluatorNotes,
      timestamp: new Date().toISOString(),
    };
  }
}
