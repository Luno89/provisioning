import { describe, expect, it } from 'vitest';
import { afterMove, afterRemove, forClients, marked, seenByClients, sharing } from './client-files.js';

const entries = [
  { path: 'designs', type: 'dir' as const },
  { path: 'designs/logo.png', type: 'file' as const },
  { path: 'contracts', type: 'dir' as const },
  { path: 'notes.txt', type: 'file' as const },
];

describe('files shared with a project\'s clients', () => {
  it('lets a client see what was shared and the folders that lead to it, nothing else', () => {
    expect(forClients(entries, ['designs/logo.png']).map((entry) => [entry.path, entry.forClients])).toEqual([['designs', undefined], ['designs/logo.png', 'itself']]);
    expect(forClients(entries, ['designs']).map((entry) => entry.path)).toEqual(['designs', 'designs/logo.png']);
    expect(seenByClients('designs/old/a.png', ['designs'])).toBe(true);
    expect(seenByClients('designer.png', ['designs'])).toBe(false);
  });

  it('marks what is shared by itself and what through its folder', () => {
    expect(marked(entries, ['designs']).map((entry) => entry.forClients)).toEqual(['itself', 'folder', undefined, undefined]);
  });

  it('shares and stops sharing, folding what a shared folder already covers', () => {
    expect(sharing(['designs/logo.png'], 'designs', true)).toEqual(['designs']);
    expect(sharing(['designs'], 'designs/logo.png', true)).toEqual(['designs']);
    expect(sharing(['designs', 'notes.txt'], 'designs', false)).toEqual(['notes.txt']);
  });

  it('follows a move and forgets what was removed', () => {
    expect(afterMove(['designs/logo.png', 'notes.txt'], 'designs', 'brand')).toEqual(['brand/logo.png', 'notes.txt']);
    expect(afterRemove(['designs/logo.png', 'notes.txt'], 'designs')).toEqual(['notes.txt']);
  });
});
