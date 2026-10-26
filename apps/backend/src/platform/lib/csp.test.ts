import { describe, expect, it } from 'vitest';
import { CSP_REPORT_PATH, cspHeader, cspModeFrom, policyText, SPA_POLICY, violationLine } from './csp.js';

describe('the content security policy', () => {
  it('is off in development unless asked for, and enforced in production unless asked only to report', () => {
    expect(cspModeFrom({})).toBe('off');
    expect(cspModeFrom({ NODE_ENV: 'production' })).toBe('enforce');
    expect(cspModeFrom({ NODE_ENV: 'production', CSP: 'report' })).toBe('report');
    expect(cspModeFrom({ NODE_ENV: 'production', CSP: 'enforce' })).toBe('enforce');
    expect(cspModeFrom({ NODE_ENV: 'production', CSP: 'off' })).toBe('off');
    expect(cspModeFrom({ CSP: 'report' })).toBe('report');
    expect(cspModeFrom({ CSP: ' Enforce ' })).toBe('enforce');
  });

  it('names the header by the mode and carries every directive', () => {
    expect(cspHeader('off')).toBeUndefined();
    expect(cspHeader('report')?.name).toBe('Content-Security-Policy-Report-Only');
    expect(cspHeader('enforce')?.name).toBe('Content-Security-Policy');
    const value = cspHeader('enforce')!.value;
    for (const directive of Object.keys(SPA_POLICY)) expect(value).toContain(`${directive} `);
    expect(value).toContain("frame-ancestors 'none'");
    expect(value).toContain("object-src 'none'");
    expect(value).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(value).not.toContain('unsafe-eval');
    expect(policyText({ 'img-src': ["'self'", 'data:'] })).toBe("img-src 'self' data:");
  });

  it('lets the page run its own scripts, styles, workers and same-origin sockets and nothing from elsewhere', () => {
    expect(SPA_POLICY['script-src']).toEqual(["'self'"]);
    expect(SPA_POLICY['connect-src']).toEqual(["'self'"]);
    expect(SPA_POLICY['worker-src']).toContain('blob:');
    expect(SPA_POLICY['style-src']).toContain("'unsafe-inline'");
  });

  it('turns a browser report into one line, in both report formats, and ignores what is not a report', () => {
    expect(violationLine({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'https://cdn.example', 'document-uri': 'https://koala.test/#/projects', 'source-file': 'https://koala.test/assets/app.js', 'line-number': 12 } }))
      .toBe('script-src blocked https://cdn.example on https://koala.test/#/projects (https://koala.test/assets/app.js:12)');
    expect(violationLine([{ type: 'csp-violation', url: 'https://koala.test/', body: { effectiveDirective: 'img-src', blockedURL: 'https://img.example/a.png' } }, { type: 'deprecation', body: {} }]))
      .toBe('img-src blocked https://img.example/a.png on https://koala.test/');
    expect(violationLine({ 'csp-report': { 'violated-directive': 'style-src-elem' } })).toBe('style-src-elem blocked inline');
    expect(violationLine({ hello: 'world' })).toBeUndefined();
    expect(violationLine('nonsense')).toBeUndefined();
    expect(violationLine(undefined)).toBeUndefined();
  });
});
