import { describe, expect, it } from 'vitest';
import { describedCall } from './hub-lines.js';

const asked = { id: 'c1', projectId: 'abc', op: 'files.upload' as const, args: { dir: '' }, as: { personId: 'bo', email: 'bo@example.com', role: 'collaborator' as const } };

describe('a call the hub sends an instance over its socket', () => {
  it('describes an upload by its type and size, never its bytes, which the instance fetches on its own', () => {
    expect(describedCall({ ...asked, upload: { stream: 'the bytes', type: 'text/plain', size: 1 } })).toEqual({ ...asked, upload: { type: 'text/plain', size: 1 } });
    expect(describedCall({ ...asked, upload: { stream: 'the bytes', type: 'text/plain' } })).toEqual({ ...asked, upload: { type: 'text/plain' } });
    expect(describedCall(asked)).toEqual(asked);
  });
});
