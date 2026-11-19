import { describe, expect, it } from 'vitest';
import { innermostMessage } from './innermost-message.js';

describe('innermostMessage', () => {
  it('says the deepest cause that has a message', () => {
    const err = new Error('the step failed', { cause: new Error('the disk is full', { cause: { message: '' } }) });
    expect(innermostMessage(err, 'it failed')).toBe('the disk is full');
  });

  it('says what it was given when nothing in the chain has a message', () => {
    expect(innermostMessage(undefined, 'the setup failed')).toBe('the setup failed');
    expect(innermostMessage({ cause: {} }, 'the release failed')).toBe('the release failed');
  });
});
