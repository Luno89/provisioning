import { describe, it, expect } from 'vitest';
import {
  assessLoopProgress,
  failureSignature,
  buildFeedbackPrompt,
  recordFromSummary,
  writeValidationArtifacts,
  readValidationFeedback,
  type ValidationRoundRecord,
} from './worker-validator-loop.js';
import type { ValidationSummary } from '../services/UniversalValidatorService.js';

describe('worker-validator-loop', () => {
  it('terminates with success when all checks pass', () => {
    const round: ValidationRoundRecord = {
      round: 1,
      passed: true,
      totalChecks: 3,
      passedChecks: 3,
      failedChecks: 0,
      failures: [],
      diagnosticReport: 'All passed',
    };

    const assessment = assessLoopProgress(undefined, round);
    expect(assessment.isComplete).toBe(true);
    expect(assessment.shouldContinue).toBe(false);
    expect(assessment.reason).toContain('All 3 validation check(s) passed');
  });

  it('allows refinement when initial round has failures', () => {
    const round: ValidationRoundRecord = {
      round: 1,
      passed: false,
      totalChecks: 3,
      passedChecks: 1,
      failedChecks: 2,
      failures: [
        { checkId: 'c1', name: 'Check 1', error: 'SyntaxError' },
        { checkId: 'c2', name: 'Check 2', error: 'File missing' },
      ],
      diagnosticReport: '2 failed',
    };

    const assessment = assessLoopProgress(undefined, round);
    expect(assessment.isComplete).toBe(false);
    expect(assessment.shouldContinue).toBe(true);
    expect(assessment.feedbackPrompt).toContain('## ⚠️ Validation Feedback (Round 1 of 4)');
    expect(assessment.feedbackPrompt).toContain('Check 1');
    expect(assessment.feedbackPrompt).toContain('SyntaxError');
  });

  it('continues when passing checks increase', () => {
    const prev: ValidationRoundRecord = {
      round: 1,
      passed: false,
      totalChecks: 4,
      passedChecks: 1,
      failedChecks: 3,
      failures: [
        { checkId: 'c1', name: 'Check 1', error: 'err1' },
        { checkId: 'c2', name: 'Check 2', error: 'err2' },
        { checkId: 'c3', name: 'Check 3', error: 'err3' },
      ],
      diagnosticReport: '3 failed',
    };

    const curr: ValidationRoundRecord = {
      round: 2,
      passed: false,
      totalChecks: 4,
      passedChecks: 3,
      failedChecks: 1,
      failures: [{ checkId: 'c3', name: 'Check 3', error: 'err3' }],
      diagnosticReport: '1 failed',
    };

    const assessment = assessLoopProgress(prev, curr);
    expect(assessment.shouldContinue).toBe(true);
    expect(assessment.reason).toContain('Passing checks increased from 1 to 3');
  });

  it('halts when loop stalls on identical failures with no repo changes', () => {
    const prev: ValidationRoundRecord = {
      round: 1,
      passed: false,
      totalChecks: 2,
      passedChecks: 1,
      failedChecks: 1,
      failures: [{ checkId: 'c1', name: 'Build', error: 'Cannot find module zod' }],
      diagnosticReport: '1 failed',
      commits: 1,
      changedFiles: ['index.js'],
    };

    const curr: ValidationRoundRecord = {
      round: 2,
      passed: false,
      totalChecks: 2,
      passedChecks: 1,
      failedChecks: 1,
      failures: [{ checkId: 'c1', name: 'Build', error: 'Cannot find module zod' }],
      diagnosticReport: '1 failed',
      commits: 1,
      changedFiles: ['index.js'],
    };

    const assessment = assessLoopProgress(prev, curr);
    expect(assessment.shouldContinue).toBe(false);
    expect(assessment.reason).toContain('Loop stalled: Worker made no repository changes');
  });

  it('halts when reaching max validation rounds', () => {
    const curr: ValidationRoundRecord = {
      round: 4,
      passed: false,
      totalChecks: 2,
      passedChecks: 1,
      failedChecks: 1,
      failures: [{ checkId: 'c1', name: 'Build', error: 'Failed' }],
      diagnosticReport: '1 failed',
    };

    const assessment = assessLoopProgress(undefined, curr, 4);
    expect(assessment.shouldContinue).toBe(false);
    expect(assessment.reason).toContain('Reached maximum validation rounds (4)');
  });

  it('records validation round cleanly from UniversalValidatorService summary', () => {
    const summary: ValidationSummary = {
      passed: false,
      type: 'command',
      totalChecks: 2,
      passedChecks: 1,
      failedChecks: 1,
      checks: [
        { id: 'chk1', name: 'File Check', passed: true, type: 'file-exists', durationMs: 10, message: 'exists' },
        { id: 'chk2', name: 'Command Check', passed: false, type: 'run-command', durationMs: 20, message: 'Command failed', outputSnippet: 'Command exited 1' },
      ],
      diagnosticReport: '1 of 2 passed',
    };

    const record = recordFromSummary(1, summary, { commits: 2, changedFiles: ['file.ts'] });
    expect(record.round).toBe(1);
    expect(record.passed).toBe(false);
    expect(record.totalChecks).toBe(2);
    expect(record.passedChecks).toBe(1);
    expect(record.failedChecks).toBe(1);
    expect(record.failures).toHaveLength(1);
    expect(record.failures[0]?.checkId).toBe('chk2');
    expect(record.failures[0]?.error).toBe('Command exited 1');
  });

  it('halts loop if worker stopped without making repo changes', () => {
    const round: ValidationRoundRecord = {
      round: 1,
      passed: false,
      totalChecks: 2,
      passedChecks: 0,
      failedChecks: 2,
      failures: [{ checkId: 'c1', name: 'Check', error: 'Fail' }],
      diagnosticReport: '0 passed',
      commits: 0,
      changedFiles: [],
    };

    const assessment = assessLoopProgress(undefined, round, 4, 'circling');
    expect(assessment.shouldContinue).toBe(false);
    expect(assessment.reason).toContain('Worker stopped (circling) without making repository changes');
  });

  it('writes and reads validation artifacts in container storage', async () => {
    const files: Record<string, string> = {};
    const mockStorage = {
      writeFile: async (_leafId: string, p: string, content: string) => { files[p] = content; },
      readFile: async (_leafId: string, p: string) => {
        if (!files[p]) throw new Error('File not found');
        return files[p]!;
      },
    };

    const summary: ValidationSummary = {
      passed: false,
      type: 'command',
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      checks: [{ id: 'test', name: 'Test', passed: false, type: 'run-command', durationMs: 10, message: 'Failed' }],
      diagnosticReport: 'Test failed',
    };
    const roundRecord = recordFromSummary(1, summary);

    await writeValidationArtifacts(mockStorage, 'leaf-1', summary, roundRecord);
    expect(files['/work/.validation/feedback.md']).toContain('## ⚠️ Validation Feedback (Round 1 of 4)');
    expect(files['/work/.validation/report.json']).toContain('"passed": false');

    const feedback = await readValidationFeedback(mockStorage, 'leaf-1');
    expect(feedback).toContain('## ⚠️ Validation Feedback (Round 1 of 4)');
  });
});
