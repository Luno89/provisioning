import { describe, it, expect } from 'vitest';
import { redactSecrets, redactDeep, REDACTED } from './redact.js';

/**
 * Two failure modes, and the second is the easy one to miss: a redactor that eats real content
 * makes the record useless in exchange for safety it did not provide. These traces exist to answer
 * "why did this fail".
 */

describe('secrets the caller knows about', () => {
  it('replaces an exact value wherever it appears', () => {
    const token = 'gitea-abcdef1234567890';
    const out = redactSecrets(`cloning with ${token} then pushing with ${token}`, [token]);
    expect(out).not.toContain(token);
    expect(out.match(/\[redacted\]/g)).toHaveLength(2);
  });

  /**
   * The case most likely to actually occur: the credential was handed to the agent inside a clone
   * URL, so it appears percent-encoded and the literal never matches.
   */
  it('catches the value as it appears inside a URL', () => {
    const secret = 'p@ss/word+123';
    const url = `https://user:${encodeURIComponent(secret)}@gitea.local/repo.git`;
    expect(redactSecrets(url, [secret])).not.toContain(encodeURIComponent(secret));
  });

  it('ignores a "secret" too short to replace safely', () => {
    // An unset env var read as '' or a two-letter token would otherwise blank the whole trace.
    const text = 'the cat sat on the mat';
    expect(redactSecrets(text, ['at', '', undefined])).toBe(text);
  });
});

describe('shapes worth catching unprompted', () => {
  it('strips credentials out of a URL', () => {
    const out = redactSecrets('remote: https://koala:ghs_secretvalue@gitea.local/x.git');
    expect(out).toContain('https://[redacted]@gitea.local/x.git');
    expect(out).not.toContain('ghs_secretvalue');
  });

  it('catches vendor-prefixed tokens', () => {
    for (const token of [
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-123456789012-abcdefghijkl',
      'glpat-abcdefghij1234567890',
    ]) {
      expect(redactSecrets(`key is ${token}`), token).not.toContain(token);
    }
  });

  it('catches a private key block whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`config:\n${pem}\ndone`);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA');
    expect(out).toContain('done');
  });

  it('catches a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(`auth: ${jwt}`)).not.toContain(jwt);
  });

  it('catches an assigned secret without knowing its shape', () => {
    expect(redactSecrets('MONGO_PASSWORD=hunter2hunter2')).not.toContain('hunter2hunter2');
    expect(redactSecrets('api_key: "abcdef1234567890"')).not.toContain('abcdef1234567890');
  });
});

/**
 * ── THE HALF THAT IS EASY TO GET WRONG ──
 * A trace redacted into confetti is worse than the leak it prevented, because the leak was
 * hypothetical and the lost diagnostic is certain.
 */
describe('what it must NOT destroy', () => {
  it('leaves commit SHAs alone', () => {
    const text = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 fix the parser';
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves UUIDs and long identifiers alone', () => {
    const text = 'leaf 42444071-8385-4ee9-a78d-b1336d53aec6 finished';
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves ordinary code and prose alone', () => {
    const text = 'export function clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max);\n}';
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves a plain URL alone', () => {
    const text = 'cloned from https://gitea.local/koala/repo.git';
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves base64-looking payloads alone', () => {
    // A file transferred over stdin looks exactly like a secret to a naive length heuristic.
    const text = 'wrote SGVsbG8gd29ybGQsIHRoaXMgaXMgYSBmaWxlIHBheWxvYWQ=';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('walking a whole record', () => {
  it('redacts every string, however nested', () => {
    // An agent step has reasoning, content, tool arguments and results — missing one defeats it.
    const step = {
      reasoning: 'I will use ghp_abcdefghijklmnopqrstuvwxyz012345',
      toolCalls: [{ name: 'run_command', arguments: '{"command":"echo ghp_abcdefghijklmnopqrstuvwxyz012345"}' }],
      tokens: 42,
    };
    const out = redactDeep(step);

    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghij');
    // Non-strings survive untouched.
    expect(out.tokens).toBe(42);
  });

  it('does not hang on something cyclic', () => {
    const a: any = { name: 'x' };
    a.self = a;
    expect(() => redactDeep(a)).not.toThrow();
  });

  it('preserves shape exactly when there is nothing to redact', () => {
    const step = { reasoning: 'looks fine', toolResults: [{ name: 'ls', result: 'src/' }], tokens: 1 };
    expect(redactDeep(step)).toEqual(step);
  });
});
