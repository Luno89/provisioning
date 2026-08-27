import { describe, it, expect } from 'vitest';
import { CommandFailedError, salientFailure, stripAnsi } from './command-error.js';

/**
 * The real case this exists for: a CDKTF deploy failed and Temporal recorded
 * `Command failed: npx` with `stackTrace: undefined` and `applicationFailureInfo.type: "Object"`,
 * because the rejection was a plain object literal rather than an Error. The actual cause — an
 * admission webhook rejecting every Ingress — existed only in the log file on disk.
 */
const E = '\x1b';
const REAL_CDKTF_TAIL = [
  `${E}[1m${E}[33mapp-provisioning-lunorica${E}[39m${E}[22m  kubernetes_ingress_v1.gitapp: Creating...`,
  '',
  '1 Stack deploying     0 Stacks done     0 Stacks waiting',
  `${E}[31m|${E}[0m ${E}[1m${E}[31mError: ${E}[0mFailed to create Ingress 'fix-gitea-mcp/app' because: `
    + 'Internal error occurred: failed calling webhook "validate.nginx.ingress.kubernetes.io": '
    + `tls: failed to verify certificate: x509: certificate signed by unknown authority${E}[0m`,
  `${E}[31m|${E}[0m`,
  '',
  'Invoking Terraform CLI failed with exit code 1',
  '',
  '--- EXECUTION FAILED (Exit Code 1) ---',
].join('\n');

describe('stripAnsi', () => {
  it('removes colour codes so a matcher can see the text', () => {
    expect(stripAnsi(`${E}[1m${E}[31mError: boom${E}[0m`)).toBe('Error: boom');
  });
});

describe('salientFailure', () => {
  it('surfaces the Terraform error line from stdout, not just the tail', () => {
    const summary = salientFailure(REAL_CDKTF_TAIL, '');
    expect(summary).toContain('failed calling webhook');
    expect(summary).toContain('x509: certificate signed by unknown authority');
    expect(summary).not.toContain(E);
  });

  it('prefers stderr when it carries the error', () => {
    const summary = salientFailure('some noise', 'Error: ENOENT: no such file or directory');
    expect(summary).toContain('ENOENT');
  });

  it('falls back to the tail when nothing matches an error pattern', () => {
    const summary = salientFailure('line one\nline two\nline three', '');
    expect(summary).toContain('line three');
  });

  it('returns empty for empty output rather than inventing a cause', () => {
    expect(salientFailure('', '')).toBe('');
  });
});

describe('CommandFailedError', () => {
  it('is a real Error, so Temporal records a type and a stack', () => {
    const err = new CommandFailedError('npx', 1, REAL_CDKTF_TAIL, '', '/tmp/deploy.log');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CommandFailedError');
    expect(typeof err.stack).toBe('string');
  });

  it('puts the real cause in the message, which is what reaches workflow history', () => {
    const err = new CommandFailedError('npx', 1, REAL_CDKTF_TAIL, '', '/tmp/deploy.log');
    expect(err.message).toContain('Command failed: npx');
    expect(err.message).toContain('exit 1');
    expect(err.message).toContain('failed calling webhook');
  });

  it('names the log file so the full output is findable', () => {
    const err = new CommandFailedError('npx', 1, 'x', '', '/tmp/deploy.log');
    expect(err.message).toContain('/tmp/deploy.log');
    expect(err.logFile).toBe('/tmp/deploy.log');
  });

  it('keeps stdout and stderr addressable for callers that want them', () => {
    const err = new CommandFailedError('npx', 2, 'OUT', 'ERR', '/tmp/x.log');
    expect(err.stdout).toBe('OUT');
    expect(err.stderr).toBe('ERR');
    expect(err.exitCode).toBe(2);
  });

  it('stays readable when the command produced nothing', () => {
    const err = new CommandFailedError('npx', 1, '', '', '/tmp/x.log');
    expect(err.message).toContain('Command failed: npx');
    expect(err.message).not.toContain('undefined');
  });
});
