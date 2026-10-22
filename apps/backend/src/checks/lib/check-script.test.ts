import { describe, it, expect } from 'vitest';
import { answerFrom, scriptProblems, type CheckScript, type ScriptRequest } from './check-script.js';

const TOOLS = new Set(['write_file', 'settle_leaf', 'research', 'run_command', 'record_verdict']);
const context = { tasks: ['task-a', 'task-b'], leaves: ['leaf-1'], world: { treeId: 'tree-9', leafIds: { alpha: 'leaf-1' } } };

const request = (over: Partial<ScriptRequest> = {}): ScriptRequest => ({
  tools: ['write_file', 'run_command'],
  messages: [
    { role: 'system', content: 'You help. Write what you produce under /work/research/run-7/ and nowhere else in /work.' },
    { role: 'user', content: 'Work the task Write greeting.txt (task-b).' },
  ],
  ...over,
});

describe('a check script', () => {
  it('answers with the first rule whose conditions hold, filling in what it looks up', () => {
    const script: CheckScript = { rules: [
      { when: { offered: ['settle_leaf'] }, reply: { say: 'not this one' } },
      { when: { offered: ['write_file'], notCalled: ['write_file'], asked: 'Work the task (.+?) \\(' }, reply: { call: [{ tool: 'write_file', arguments: { path: '{{directory}}notes.md', content: 'for {{asked.1}} on {{mentioned.task}} in {{world.treeId}}' } }] } },
      { when: { offered: ['write_file'] }, reply: { say: 'done' } },
    ] };

    expect(answerFrom(script, request(), context)).toEqual({
      rule: 1,
      answer: { calls: [{ name: 'write_file', arguments: { path: 'research/run-7/notes.md', content: 'for Write greeting.txt on task-b in tree-9' } }] },
    });
  });

  it('tells calls made this turn apart from calls made before it', () => {
    const script: CheckScript = { rules: [
      { when: { called: ['write_file'] }, reply: { say: 'wrote it: {{result.write_file}}' } },
      { when: {}, reply: { call: [{ tool: 'write_file', arguments: {} }] } },
    ] };
    const afterCall = request({ messages: [
      ...request().messages,
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'wrote 5 bytes to notes.md' },
    ] });
    const nextTurn = request({ messages: [...afterCall.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'again' }] });

    expect(answerFrom(script, afterCall, context)).toMatchObject({ answer: { say: 'wrote it: wrote 5 bytes to notes.md' } });
    expect(answerFrom(script, nextTurn, context)).toMatchObject({ rule: 1 });
  });

  it('says plainly when it has no answer, or when a lookup finds nothing', () => {
    expect(answerFrom({ rules: [{ when: { offered: ['settle_leaf'] }, reply: { say: 'x' } }] }, request(), context))
      .toEqual({ miss: 'the script has no answer for a request offering write_file, run_command, asked "Work the task Write greeting.txt (task-b)."' });
    expect(answerFrom({ rules: [{ when: {}, reply: { say: '{{mentioned.leaf}}' } }] }, request(), context))
      .toEqual({ miss: 'rule 1 matched, but {{mentioned.leaf}} has nothing: no leaf of this check is named in what the model was sent' });
    expect(answerFrom({ rules: [{ when: {}, reply: { say: '{{world.missing}}' } }] }, request(), context))
      .toEqual({ miss: 'rule 1 matched, but {{world.missing}} has nothing: no earlier stage recorded it' });
  });

  it('is checked before it is saved', () => {
    expect(scriptProblems({ rules: [] }, TOOLS)).toEqual(['a script needs at least one rule']);
    expect(scriptProblems({ rules: [
      { when: { offered: ['fly'], asked: '(' }, reply: {} },
      { when: { mood: 'x' }, reply: { call: [{ tool: 'teleport', arguments: {} }], say: '{{weather}}' } },
    ] }, TOOLS)).toEqual([
      'rule 1: asked is not a regular expression: Invalid regular expression: /(/s: Unterminated group',
      'rule 1: fly is not a tool',
      'rule 1 has to say something or call a tool',
      'rule 2: "mood" is not something a rule can match on',
      'rule 2 calls teleport, which is not a tool',
      'rule 2 looks up {{weather}}, which is not one of asked, said, directory, mentioned, result, world',
    ]);
  });
});
