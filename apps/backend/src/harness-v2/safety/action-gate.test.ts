import { describe, it, expect } from 'vitest';
import { ActionGate } from './action-gate.js';
import { AstValidator } from './ast-validator.js';

describe('AstValidator', () => {
  it('allows safe commands and paths inside workspace', () => {
    const res = AstValidator.inspectCommand('npm test', '/work');
    expect(res.safe).toBe(true);
    expect(res.riskLevel).toBe('low');

    const pathCheck = AstValidator.validatePath('/work/repo/src/index.ts', '/work');
    expect(pathCheck.valid).toBe(true);
  });

  it('blocks catastrophic rm -rf / and root directory deletions', () => {
    const res1 = AstValidator.inspectCommand('rm -rf /', '/work');
    expect(res1.safe).toBe(false);
    expect(res1.riskLevel).toBe('critical');

    const res2 = AstValidator.inspectCommand('rm -rf /*', '/work');
    expect(res2.safe).toBe(false);
  });

  it('blocks forced push to protected branches', () => {
    const res = AstValidator.inspectCommand('git push --force origin main', '/work');
    expect(res.safe).toBe(false);
    expect(res.riskLevel).toBe('critical');
  });

  it('blocks escaping workspace boundaries via path traversal', () => {
    const pathCheck = AstValidator.validatePath('/etc/passwd', '/work');
    expect(pathCheck.valid).toBe(false);
    expect(pathCheck.reason).toMatch(/sensitive path/i);

    const escapeCheck = AstValidator.validatePath('/work/../../etc/shadow', '/work');
    expect(escapeCheck.valid).toBe(false);
  });
});

describe('ActionGate', () => {
  const context = {
    taskId: 'task-123',
    personaId: 'persona-coder',
    personaRole: 'coder',
    workspacePath: '/work/repo',
  };

  it('allows valid write_file inside workspace', () => {
    const verdict = ActionGate.evaluate({
      toolName: 'write_file',
      args: { path: '/work/repo/src/app.ts', content: 'console.log("ok");' },
      context,
    });

    expect(verdict.allowed).toBe(true);
  });

  it('blocks researcher role from modifying files', () => {
    const verdict = ActionGate.evaluate({
      toolName: 'write_file',
      args: { path: '/work/repo/src/app.ts', content: 'modified' },
      context: { ...context, personaRole: 'researcher' },
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.refusalReason).toMatch(/restricted to read-only/i);
  });

  it('formats helpful structured refusal message for the model', () => {
    const verdict = ActionGate.evaluate({
      toolName: 'run_command',
      args: { command: 'rm -rf /' },
      context,
    });

    expect(verdict.allowed).toBe(false);
    const msg = ActionGate.formatRefusalResult('run_command', verdict);
    expect(msg).toContain('[ACTION GATE REFUSAL]');
    expect(msg).toContain('critical risk');
  });
});
