import { describe, expect, it } from 'vitest';
import { rootAnswer } from './root-answer.js';

describe('rootAnswer', () => {
  it('reads the body and the error root gave', () => {
    expect(rootAnswer(true, 200, '{"nested":true}')).toEqual({ body: { nested: true }, error: undefined });
    expect(rootAnswer(false, 401, '{"error":"unknown instance or credential"}')).toEqual({ body: { error: 'unknown instance or credential' }, error: 'unknown instance or credential' });
  });

  it('takes an empty answer as saying nothing', () => {
    expect(rootAnswer(true, 200, '')).toEqual({ body: {}, error: undefined });
  });

  it('gives no reason for a refusal that is not JSON, so the caller names the status', () => {
    expect(rootAnswer(false, 502, '<html>Bad Gateway</html>')).toEqual({ body: {}, error: undefined });
  });

  it('refuses an answer that says it went through but is not JSON', () => {
    expect(() => rootAnswer(true, 200, '<html>a login page</html>')).toThrow('root answered 200 with something that is not JSON: <html>a login page</html>');
  });

  it('takes only a string as the error', () => {
    expect(rootAnswer(false, 400, '{"error":{"code":1}}').error).toBeUndefined();
  });
});
