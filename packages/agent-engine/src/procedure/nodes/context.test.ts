import { describe, it, expect } from 'vitest';
import { clampToolResult, openingWith } from './context.js';

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
