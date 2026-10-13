import { describe, it, expect } from 'vitest';
import { openingWith } from '@koala/agent-engine/procedure';
import { conversationContext } from './conversation-context.js';

describe('what a conversation hands Koala with each message', () => {
  it('is the named inputs it is bound to, as the text that follows the person\'s message', () => {
    const bound = { treeId: 't1', tree: 'Tree "Shop" (t1), type odoo-addons.', projectId: '' };
    const context = conversationContext(bound);
    expect(context.given).toEqual({ treeId: 't1', tree: 'Tree "Shop" (t1), type odoo-addons.' });
    expect(`what is left?\n\n${context.text}`).toBe(openingWith('what is left?', bound));
    expect(context.text).toBe('treeId: t1\n\ntree: Tree "Shop" (t1), type odoo-addons.');
  });

  it('is nothing for a conversation bound to nothing', () => {
    expect(conversationContext(undefined)).toEqual({ given: {}, text: '' });
  });
});
