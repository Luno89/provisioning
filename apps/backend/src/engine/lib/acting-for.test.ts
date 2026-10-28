import { describe, expect, it } from 'vitest';
import { heldBackFromOthers, keptToProblem, memberAsking } from './acting-for.js';

describe('how a member is named to Koala', () => {
  it('says who is asking and that they are not the owner', () => {
    expect(memberAsking({ email: 'cy@example.com', role: 'client' })).toBe('cy@example.com, a client on this shared project and not its owner,');
  });
});

describe('what the memory keeper does with a conversation others talked in', () => {
  it('keeps only project memories, replaces and forgets nothing, and proposes nothing', () => {
    expect(keptToProblem('save_memory', { title: 'x', text: 'y' })).toBeUndefined();
    expect(keptToProblem('save_memory', { title: 'x', text: 'y', scope: 'project' })).toBeUndefined();
    expect(keptToProblem('save_memory', { title: 'x', text: 'y', scope: 'global' })).toMatch(/never global/);
    expect(keptToProblem('save_memory', { title: 'x', text: 'y', replaces: 'm1' })).toMatch(/replaces nothing/);
    for (const tool of ['forget_memory', 'propose_practice', 'propose_prompt_change', 'propose_scenario', 'propose_tool_note', 'request_procedure_change']) {
      expect(keptToProblem(tool, {}), tool).toMatch(/people other than the owner/);
      expect(heldBackFromOthers(tool)).toBe(true);
    }
    expect(keptToProblem('search_memories', { query: 'x' })).toBeUndefined();
  });
});
