import { describe, it, expect } from 'vitest';
import { RubricEvaluator } from './rubric-evaluator.js';

describe('RubricEvaluator', () => {
  it('passes code task with passing tests and complete implementation', () => {
    const verdict = RubricEvaluator.evaluate({
      taskType: 'code',
      taskPrompt: 'Implement authentication middleware',
      outputArtifacts: ['src/auth.ts'],
      gitDiff: '+export function auth() { return true; }',
      testResults: { passed: true, stdout: '5 passed' },
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(80);
    expect(verdict.rubricBreakdown.test_pass_rate.passed).toBe(true);
  });

  it('fails code task when tests fail or TODO placeholders exist', () => {
    const verdict = RubricEvaluator.evaluate({
      taskType: 'code',
      taskPrompt: 'Implement billing webhook',
      outputArtifacts: ['src/webhook.ts'],
      gitDiff: '+// TODO: finish this later\n+export function webhook() {}',
      testResults: { passed: false, stdout: '1 failed' },
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBeLessThan(80);
    expect(verdict.evaluatorNotes).toMatch(/deficiencies detected/i);
  });

  it('evaluates research task based on citations and actionable takeaways', () => {
    const verdict = RubricEvaluator.evaluate({
      taskType: 'research',
      taskPrompt: 'Research distributed harnesses',
      outputArtifacts: ['findings.md'],
      findingsContent: '# Findings\n\n## Sources\n- https://temporal.io\n\n## Recommendations and trade-offs\nUse durable execution. '.repeat(20),
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(100);
  });
});
