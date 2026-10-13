import { describe, it, expect } from 'vitest';
import type { MemoryItem } from './memory-store.js';
import { checksForNote, notesForRun, noteSubject, withLearned } from './tool-notes.js';

const note = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'n', ownerId: 'u1', category: 'tool_note', status: 'active', title: 'Note', text: 'A note.', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
});

describe('notes learned about tools', () => {
  it('reach a run only when live, and those kept for one model only on that model', () => {
    const notes = notesForRun([
      note({ id: 'a', tool: 'start_task', text: 'It claims the task.' }),
      note({ id: 'b', tool: 'start_task', text: 'Only on qwen.', model: 'qwen/q', createdAt: '2026-01-02' }),
      note({ id: 'c', tool: 'start_task', text: 'Only on another.', model: 'other/m' }),
      note({ id: 'd', tool: 'start_task', text: 'On trial.', status: 'trial' }),
      note({ id: 'e', tool: 'start_task', text: 'Retired.', invalidAt: '2026-01-03' }),
      note({ id: 'f', server: 'playwright', text: 'Wait for the page.' }),
      note({ id: 'g', server: 'playwright', tool: 'browser_click', text: 'Click by ref.' }),
      { ...note({ id: 'h', text: 'A lesson.' }), category: 'lessons_learned' },
    ], 'qwen/q');

    expect(notes).toEqual({
      tools: { start_task: ['It claims the task.', 'Only on qwen.'], playwright__browser_click: ['Click by ref.'] },
      servers: { playwright: ['Wait for the page.'] },
    });
    expect(notesForRun([note({ tool: 'start_task', model: 'qwen/q' })], undefined)).toEqual({ tools: {}, servers: {} });
  });

  it('are put on the tools offered and on the server that serves them', () => {
    const tools = withLearned([
      { name: 'start_task', description: 'Claim', binding: 'platform' },
      { name: 'list_dir', description: 'List', binding: 'environment' },
      { name: 'playwright__browser_click', description: 'Click', binding: 'environment', servedBy: { server: 'playwright', where: 'workspace' } },
    ], { tools: { start_task: ['It claims the task.'], playwright__browser_click: ['Click by ref.'] }, servers: { playwright: ['Wait for the page.'] } });

    expect(tools[0]).toMatchObject({ learned: ['It claims the task.'] });
    expect(tools[1]).not.toHaveProperty('learned');
    expect(tools[2]).toMatchObject({ learned: ['Click by ref.'], servedBy: { server: 'playwright', learned: ['Wait for the page.'] } });
  });

  it('are tried on the checks that touch the tool, or any tool of the server', () => {
    const scenarios = [
      { id: 'claims', tools: ['start_task'] },
      { id: 'browses', tools: ['playwright__browser_click', 'read_file'] },
      { id: 'snapshots', tools: ['playwright__browser_snapshot'] },
      { id: 'none' },
    ];
    expect(checksForNote(scenarios, { tool: 'start_task' })).toEqual(['claims']);
    expect(checksForNote(scenarios, { server: 'playwright', tool: 'browser_click' })).toEqual(['browses']);
    expect(checksForNote(scenarios, { server: 'playwright' })).toEqual(['browses', 'snapshots']);
  });

  it('say what they are about', () => {
    expect(noteSubject({ tool: 'start_task' })).toBe('start_task');
    expect(noteSubject({ server: 'playwright' })).toBe('the playwright server');
    expect(noteSubject({ server: 'playwright', tool: 'browser_click' })).toBe('browser_click on playwright');
  });
});
