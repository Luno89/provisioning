import { describe, it, expect } from 'vitest';
import { clampToolResult, extendConversation, handOff, openingWith } from './context.js';
import { REFUSED_CALL } from './orchestration.js';

function theReply(id: string, content: string, callIds: string[] = [], name = 'run_command') {
  return {
    id,
    content,
    thinking: '',
    finishReason: callIds.length ? 'tool_use' : 'stop',
    toolCalls: callIds.map((callId) => ({ id: callId, name, arguments: '{}' })),
  };
}

function theResult(forReply: string, callId: string, content: string, ok = true) {
  return { forReply, callId, name: 'run_command', ok, digest: content, content };
}

describe('putting what the run was given in front of the model', () => {
  it('says the message on its own when the run was given nothing else', () => {
    expect(openingWith('Do the task.', undefined)).toBe('Do the task.');
    expect(openingWith('Do the task.', {})).toBe('Do the task.');
  });

  it('labels each named input under the message', () => {
    expect(openingWith('Plan this.', { goal: 'Add a healthz endpoint' }))
      .toBe('Plan this.\n\ngoal: Add a healthz endpoint');
  });

  it('never repeats a value the message already says', () => {
    expect(openingWith('Add a healthz endpoint', { goal: 'Add a healthz endpoint' }))
      .toBe('Add a healthz endpoint');
  });

  it('leaves out the message itself, and anything empty', () => {
    expect(openingWith('Do it.', { message: 'Do it.', note: '', missing: undefined, nothing: null }))
      .toBe('Do it.');
  });

  it('writes a structured input out in full, so nothing about it is lost', () => {
    const opening = openingWith('Do the task you have been given.', {
      item: { id: 'write-greeting', title: 'Write hello.txt', doneMeans: 'hello.txt says hello' },
    });

    expect(opening).toContain('write-greeting');
    expect(opening).toContain('Write hello.txt');
    expect(opening).toContain('hello.txt says hello');
  });

  it('stands on its own when there is no message at all', () => {
    expect(openingWith('', { question: 'Who made Rust?' })).toBe('question: Who made Rust?');
  });
});

describe('capping how much of a tool result the model sees', () => {
  it('leaves a result that already fits alone', () => {
    expect(clampToolResult('all of it', 100)).toBe('all of it');
  });

  it('keeps the end of ordinary output, where the error usually is', () => {
    const trimmed = clampToolResult(`${'a'.repeat(50)}command failed`, 20);

    expect(trimmed).toContain('command failed');
    expect(trimmed).toContain('truncated from the start');
  });

  it('keeps the start of a JSON result, where it says what it is', () => {
    const procedure = `{"schema":2,"id":"triage","name":"Triage","nodes":[${'{"id":"x"},'.repeat(80)}]}`;
    const trimmed = clampToolResult(procedure, 60);

    expect(trimmed.startsWith('{"schema":2,"id":"triage"')).toBe(true);
    expect(trimmed).toContain('truncated from the end');
  });

  it('keeps the start of a JSON array too', () => {
    expect(clampToolResult(`[${'1,'.repeat(100)}]`, 20).startsWith('[1,1,1')).toBe(true);
  });
});

describe('remembering what each round of the conversation asked for and got back', () => {
  it('files each result under the round whose reply called it', () => {
    const first = extendConversation(
      undefined,
      'run the thing',
      [theReply('turn.call#1', '', ['c1'])],
      [[theResult('turn.call#1', 'c1', 'bob said no', false)]],
    );
    const second = extendConversation(first, 'run the thing', [theReply('turn.call#2', 'it ran fine')], []);

    expect(second.rounds.map((round) => round.reply.id)).toEqual(['turn.call#1', 'turn.call#2']);
    expect(second.rounds[0]!.results).toEqual([theResult('turn.call#1', 'c1', 'bob said no', false)]);
    expect(second.rounds[1]!.results).toEqual([]);
    expect(second.rounds[1]!.reply.content).toBe('it ran fine');
  });

  it('keeps a refusal as a result of its round, not as a gap', () => {
    const state = extendConversation(
      undefined,
      'run the thing',
      [theReply('turn.call#1', '', ['c1', 'c2'])],
      [[
        theResult('turn.call#1', 'c1', REFUSED_CALL, false),
        theResult('turn.call#1', 'c2', 'did it'),
      ]],
    );

    expect(state.rounds[0]!.results.map((result) => [result.callId, result.ok])).toEqual([['c1', false], ['c2', true]]);
  });

  it('records a round and its results once, even when the node runs again with the same piece', () => {
    const reply = theReply('turn.call#1', '', ['c1']);
    const results = [[theResult('turn.call#1', 'c1', 'did it')]];
    const once = extendConversation(undefined, 'run the thing', [reply], results);
    const twice = extendConversation(once, 'run the thing', [reply], results);

    expect(twice.rounds).toEqual(once.rounds);
    expect(twice.messages).toEqual(once.messages);
    expect(twice.rounds[0]!.results).toHaveLength(1);
  });

  it('carries the rounds forward when a result lands on a round from an earlier run', () => {
    const asked = extendConversation(undefined, 'run the thing', [theReply('turn.call#1', '', ['c1'])], []);
    const answered = extendConversation(asked, 'run the thing', [], [[theResult('turn.call#1', 'c1', 'did it')]]);

    expect(answered.rounds[0]!.results).toEqual([theResult('turn.call#1', 'c1', 'did it')]);
  });
});

describe('handOff continuity state preservation', () => {
  it('preserves initial goal, subsequent user directives, and negative knowledge without losing scope', () => {
    const messages = [
      { role: 'user' as const, content: 'Initial task: Implement auth service' },
      { role: 'assistant' as const, content: 'Starting implementation' },
      { role: 'user' as const, content: 'CRITICAL DIRECTIVE: Do not use SQLite, use Postgres only' },
      { role: 'assistant' as const, content: 'Running db migration' },
      { role: 'tool' as const, name: 'run_command', content: 'exit code 1: Connection refused on port 5432' },
      { role: 'user' as const, content: 'Also ensure port 5433 is used instead' },
      { role: 'assistant' as const, content: 'Connecting to port 5433' },
      { role: 'tool' as const, name: 'run_command', content: 'Connection successful' },
      { role: 'user' as const, content: 'Tail prompt 1' },
      { role: 'assistant' as const, content: 'Tail reply 1' },
    ];

    const result = handOff(messages, {
      at: 0.5,
      tail: 2,
      goalChars: 500,
      discoveries: 5,
      discoveryChars: 150,
    });

    const handoffText = result[0]?.content ?? '';
    // Preserves initial goal
    expect(handoffText).toContain('Implement auth service');
    // Preserves subsequent user directives
    expect(handoffText).toContain('Do not use SQLite, use Postgres only');
    expect(handoffText).toContain('Also ensure port 5433 is used instead');
    // Preserves negative knowledge / failed tool error
    expect(handoffText).toContain('Connection refused on port 5432');
    // Preserves live tail
    expect(result[result.length - 1]?.content).toBe('Tail reply 1');
  });

  it('supports dual-boundary clamping with configurable headRatio', () => {
    const big = 'HEADER_INFO\n' + 'intermediate line\n'.repeat(50) + 'FINAL_ERROR_TRACE';
    const clamped = clampToolResult(big, 80, 0.25);
    expect(clamped).toContain('HEADER_INFO');
    expect(clamped).toContain('FINAL_ERROR_TRACE');
    expect(clamped).toContain('characters omitted');
  });
});
