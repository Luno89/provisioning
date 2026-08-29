import { describe, it, expect } from 'vitest';
import { splitProposalBlock } from './proposal-display.js';

const REAL_BLOCK = `Here is how I would break that up.

\`\`\`json
{"leaves":[{"title":"Scaffold Node.js adapter project","body":"Initialize the repository."},{"title":"Configure MongoDB connection","body":"Install a driver."}]}
\`\`\``;

describe('splitProposalBlock', () => {
  it('strips the block and keeps the prose', () => {
    const r = splitProposalBlock(REAL_BLOCK);
    expect(r.prose).toBe('Here is how I would break that up.');
    expect(r.prose).not.toContain('leaves');
    expect(r.proposals.map((p) => p.title)).toEqual([
      'Scaffold Node.js adapter project',
      'Configure MongoDB connection',
    ]);
  });

  it('keeps bodies, so the chat can show more than titles', () => {
    expect(splitProposalBlock(REAL_BLOCK).proposals[0]!.body).toBe('Initialize the repository.');
  });

  it('leaves an ordinary reply untouched', () => {
    expect(splitProposalBlock('Just talking.')).toEqual({ prose: 'Just talking.', proposals: [], pending: false });
  });

  it('leaves a code sample alone — watching code stream is the point', () => {
    const reply = 'Try:\n```ts\nconst x = 1;\n```';
    expect(splitProposalBlock(reply).prose).toBe(reply);
  });

  it('hides a proposal block that is still arriving, and says so', () => {
    const midStream = 'Here is the plan.\n\n```json\n{"leaves":[{"title":"Scaffold the pro';
    const r = splitProposalBlock(midStream);
    expect(r.prose).toBe('Here is the plan.');
    expect(r.pending).toBe(true);
    expect(r.proposals).toEqual([]);
  });

  it('does NOT hide an unclosed code block, which should keep streaming', () => {
    const midCode = 'Try this:\n```ts\nconst x = ';
    const r = splitProposalBlock(midCode);
    expect(r.pending).toBe(false);
    expect(r.prose).toContain('const x =');
  });

  it('strips an unparseable block rather than showing broken JSON', () => {
    const broken = 'Plan:\n```json\n{"leaves":[{"title": oops}]}\n```';
    const r = splitProposalBlock(broken);
    expect(r.prose).toBe('Plan:');
    expect(r.proposals).toEqual([]);
  });

  it('drops entries with no usable title', () => {
    const reply = '```json\n{"leaves":[{"body":"orphan"},{"title":"  "},{"title":"Kept"}]}\n```';
    expect(splitProposalBlock(reply).proposals).toEqual([{ title: 'Kept' }]);
  });

  it('handles an untagged fence', () => {
    const reply = '```\n{"leaves":[{"title":"Untagged"}]}\n```';
    expect(splitProposalBlock(reply).proposals).toEqual([{ title: 'Untagged' }]);
  });

  it('handles empty input without throwing', () => {
    expect(splitProposalBlock('')).toEqual({ prose: '', proposals: [], pending: false });
    expect(() => splitProposalBlock('```json')).not.toThrow();
  });
});
