import { describe, it, expect, vi } from 'vitest';
import { extractAndSaveLeafMemories } from './leaf-memory-extract.js';

const leaf = { id: 'l1', ownerId: 'u1', title: 'Do the thing', projectId: 'p1' };

describe('extractAndSaveLeafMemories', () => {
  it('does nothing when the repo has no tracked files and the run succeeded', async () => {
    const db = { getMemories: vi.fn(async () => []), saveMemory: vi.fn(async () => undefined) };
    const workspaces = { exec: vi.fn(async () => ({ stdout: '' })) };
    const admit = vi.fn(async () => ({ action: 'ADD' as const }));

    await extractAndSaveLeafMemories({ db, workspaces, admit }, {
      leaf, summary: 's', succeeded: true, missingArtifacts: [],
    });

    expect(admit).not.toHaveBeenCalled();
    expect(db.saveMemory).not.toHaveBeenCalled();
  });

  it('saves a repository-layout memory via admit when files were tracked', async () => {
    const db = { getMemories: vi.fn(async () => []), saveMemory: vi.fn(async () => undefined) };
    const workspaces = { exec: vi.fn(async () => ({ stdout: 'src/a.ts\nsrc/b.ts\n' })) };
    const admit = vi.fn(async () => ({ action: 'ADD' as const }));

    await extractAndSaveLeafMemories({ db, workspaces, admit }, {
      leaf, summary: 's', succeeded: true, missingArtifacts: [],
    });

    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Repository layout' }));
  });

  it('invalidates a superseded prior layout memory before saving the new one', async () => {
    const prior = {
      id: 'old', ownerId: 'u1', projectId: 'p1', category: 'environment_facts' as const,
      title: 'Repository layout', text: 't', status: 'active' as const, source: 'post_run_extractor' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const db = { getMemories: vi.fn(async () => [prior]), saveMemory: vi.fn(async () => undefined) };
    const workspaces = { exec: vi.fn(async () => ({ stdout: 'src/a.ts\n' })) };
    const admit = vi.fn(async () => ({ action: 'ADD' as const }));

    await extractAndSaveLeafMemories({ db, workspaces, admit }, {
      leaf, summary: 's', succeeded: true, missingArtifacts: [],
    });

    expect(db.saveMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'old', invalidAt: expect.any(String) }));
  });

  it('does not throw when the workspace exec itself fails', async () => {
    const db = { getMemories: vi.fn(async () => []), saveMemory: vi.fn(async () => undefined) };
    const workspaces = { exec: vi.fn(async () => { throw new Error('boom'); }) };
    const admit = vi.fn(async () => ({ action: 'ADD' as const }));

    await expect(extractAndSaveLeafMemories({ db, workspaces, admit }, {
      leaf, summary: 's', succeeded: true, missingArtifacts: [],
    })).resolves.toBeUndefined();
  });
});
