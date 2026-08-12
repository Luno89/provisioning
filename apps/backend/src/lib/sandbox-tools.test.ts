import { describe, it, expect } from 'vitest';
import { pacingNoteFor, researchPacing, CODE_PACING, trimConversation, toolsForStep } from './sandbox-tools.js';

const RESEARCH = researchPacing(40, '/work/findings.md');

describe('pacing the agent towards saving its work', () => {
  it('says nothing while there is plenty of budget left', () => {
    expect(pacingNoteFor(30, RESEARCH)).toBeUndefined();
  });

  it('warns a research leaf at the halfway mark, not four steps from the end', () => {
    // Measured three times: the agent searches until the budget is gone. A warning that arrives at
    // the end arrives after the only moment it could have changed anything.
    expect(pacingNoteFor(20, RESEARCH)?.message).toContain('STOP SEARCHING');
  });

  it('escalates to the urgent note once the end is close', () => {
    const note = pacingNoteFor(3, RESEARCH);
    expect(note?.message).toContain('call `finish`');
    // The gentler halfway message would be actively misleading this late.
    expect(note?.message).not.toContain('STOP SEARCHING');
  });

  it('never tells a research leaf to commit, having no repository to commit to', () => {
    for (const remaining of [20, 10, 3, 1]) {
      expect(pacingNoteFor(remaining, RESEARCH)?.message).not.toMatch(/commit|push/i);
    }
  });

  it('scales the halfway note with the budget rather than hardcoding a step count', () => {
    expect(pacingNoteFor(50, researchPacing(100, '/work/findings.md'))?.message).toContain('STOP SEARCHING');
    expect(pacingNoteFor(51, researchPacing(100, '/work/findings.md'))).toBeUndefined();
  });

  it('still tells a coding leaf to commit and push', () => {
    expect(pacingNoteFor(2, CODE_PACING)?.message).toContain('Commit and push');
  });

  it('stops once the budget is spent — there is nothing left to act on', () => {
    expect(pacingNoteFor(0, CODE_PACING)).toBeUndefined();
    expect(pacingNoteFor(-1, RESEARCH)).toBeUndefined();
  });
});

describe('keeping the conversation inside the model window', () => {
  const big = (n: number) => 'x'.repeat(n);
  const convo = () => ([
    { role: 'system', content: 'you are an agent' },
    { role: 'user', content: 'the task' },
    { role: 'assistant', content: 'calling a tool' },
    { role: 'tool', content: big(5000) },
    { role: 'assistant', content: 'calling another' },
    { role: 'tool', content: big(5000) },
    { role: 'assistant', content: 'and another' },
    { role: 'tool', content: big(5000) },
  ]);

  it('leaves a conversation that already fits completely alone', () => {
    const m = convo();
    expect(trimConversation(m, 100_000)).toBe(m);
  });

  it('never drops the system prompt or the task', () => {
    // An agent that loses the task will confidently do the wrong thing for the rest of its budget.
    const out = trimConversation(convo(), 100);
    expect(out[0]!.content).toBe('you are an agent');
    expect(out[1]!.content).toBe('the task');
  });

  it('keeps the newest tool output and elides the oldest', () => {
    const out = trimConversation(convo(), 6000);
    expect(out[7]!.content).toBe(big(5000));
    expect(String(out[3]!.content)).toContain('dropped to fit the context window');
  });

  it('keeps every message, so tool results stay paired with their calls', () => {
    // Deleting a tool message without its assistant tool_calls entry is a malformed request the
    // API rejects outright.
    const out = trimConversation(convo(), 100);
    expect(out).toHaveLength(convo().length);
    expect(out.map((m) => m.role)).toEqual(convo().map((m) => m.role));
  });

  it('does not blank assistant turns, which carry the thread of what it was doing', () => {
    const out = trimConversation(convo(), 100);
    expect(out[2]!.content).toBe('calling a tool');
    expect(out[4]!.content).toBe('calling another');
  });

  it('actually reduces the payload', () => {
    const before = convo().reduce((n, m) => n + String(m.content).length, 0);
    const after = trimConversation(convo(), 6000).reduce((n, m) => n + String(m.content).length, 0);
    expect(after).toBeLessThan(before / 2);
  });
});

describe('taking the search tools away when instructions do not work', () => {
  const tools = [
    { function: { name: 'write_file' } },
    { function: { name: 'web_search' } },
    { function: { name: 'fetch_web_page' } },
    { function: { name: 'finish' } },
  ];
  const withdrawal = { afterStep: 50, names: ['web_search', 'fetch_web_page'] };

  it('leaves everything available in the first half', () => {
    expect(toolsForStep(49, tools, withdrawal)).toHaveLength(4);
  });

  it('removes the web tools from the halfway step onward', () => {
    const names = toolsForStep(50, tools, withdrawal).map((t) => t.function.name);
    expect(names).toEqual(['write_file', 'finish']);
  });

  it('leaves the tools it still needs to do the work it has been avoiding', () => {
    const names = toolsForStep(99, tools, withdrawal).map((t) => t.function.name);
    expect(names).toContain('write_file');
    expect(names).toContain('finish');
  });

  it('changes nothing when no withdrawal is configured', () => {
    expect(toolsForStep(99, tools, undefined)).toBe(tools);
  });
});
