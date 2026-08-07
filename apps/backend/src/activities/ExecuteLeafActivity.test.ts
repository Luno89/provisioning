/**
 * ExecuteLeafActivity, with its collaborators faked at the module boundary.
 *
 * ── WHY MOCKS AND NOT INJECTION ──
 * The activity builds its own ModelService, WorkspaceService and database on purpose: an API key is
 * a secret and a workflow argument ends up in Temporal history, so nothing may be handed in. Adding
 * an injection seam for tests would put a second construction path next to the one whose whole
 * justification is that there is only one. Faking the modules keeps the real wiring under test.
 *
 * `createDatabase` is faked rather than left to return a MemoryDB, because the activity calls
 * `init()` — which wipes leaves — so a seeded database would be empty by the time it read one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import type { Leaf } from '../lib/leaves.js';

const resolveBaseUrl = vi.fn();
const runAgentLoop = vi.fn();
const workspace = {
  create: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
  exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => undefined),
};

let db: MemoryDB;

// Returned by a closure, not captured: the factories run at import time, before any test has built
// a database for them to hand out.
vi.mock('../lib/db-interface.js', () => ({ createDatabase: () => db }));
vi.mock('../lib/model-wiring.js', () => ({ createModelService: () => ({ resolveBaseUrl }) }));
vi.mock('../lib/agent-loop.js', () => ({ runAgentLoop }));
vi.mock('../services/WorkspaceService.js', () => ({ WorkspaceService: class { constructor() { return workspace as any; } } }));

const { ExecuteLeafActivity } = await import('./ExecuteLeafActivity.js');

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'leaf-1',
  ownerId: 'u1',
  title: 'Do the thing',
  status: 'running',
  column: 'doing',
  language: 'node',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
  ...over,
} as Leaf);

/** A database the activity will read but not reset — see the header. */
const seeded = async (records: Leaf[], profile?: Record<string, unknown>) => {
  const fresh = new MemoryDB();
  await fresh.init();
  for (const l of records) await fresh.saveLeaf(l);
  if (profile) {
    await fresh.saveHarnessProfile({
      ownerId: 'u1',
      overrides: profile,
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as any);
  }
  // Own properties shadow the prototype's, so the activity's lifecycle calls become no-ops while
  // every read and write still goes to the real in-memory store.
  (fresh as any).init = async () => undefined;
  (fresh as any).close = async () => undefined;
  return fresh;
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveBaseUrl.mockResolvedValue({
    provider: { id: 'dep-1', name: 'Tabby', model: 'Qwen3-32B', kind: 'tabbyapi' },
    baseUrl: 'http://model',
  });
  runAgentLoop.mockResolvedValue({ succeeded: true, summary: 'done', tokensUsed: 120, transcript: [] });
});

describe('which model a leaf runs against', () => {
  it('resolves the promoted model, so adopting one reaches real work', async () => {
    // The regression. `model` names a PROVIDER, so unlike every other knob it cannot ride along in
    // `overrides` — the loop has no provider list to resolve it against. It was being passed there
    // and ignored, and leaves silently kept running whichever provider happened to be listed first,
    // while the Lab reported on a configuration nothing else used.
    db = await seeded([leaf()], { model: 'dep-7', temperature: 0.2 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(resolveBaseUrl).toHaveBeenCalledWith('u1', 'dep-7');
  });

  it('leaves the choice open when nothing has been promoted', async () => {
    // No selection means "first available", which is what an untuned install should do.
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(resolveBaseUrl).toHaveBeenCalledWith('u1', undefined);
  });

  it('ignores a promoted model that is not a string, rather than resolving nonsense', async () => {
    db = await seeded([leaf()], { model: 42 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(resolveBaseUrl).toHaveBeenCalledWith('u1', undefined);
  });

  it('sends the provider’s served model, never the id it was selected by', async () => {
    // `dep-1` is a selector. Asking an API for a model called "dep-1" gets a 404 from a provider
    // that is working perfectly.
    db = await seeded([leaf()], { model: 'dep-1' });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0]).toMatchObject({ model: 'Qwen3-32B', kind: 'tabbyapi' });
  });

  it('still hands the rest of the adopted profile to the loop', async () => {
    // Resolving `model` separately must not cost the knobs that DO travel as overrides — the
    // promotion mechanism is one feature, not two.
    db = await seeded([leaf()], { model: 'dep-7', temperature: 0.2, maxSteps: 9 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0].overrides).toMatchObject({ temperature: 0.2, maxSteps: 9 });
  });
});

describe('what a leaf leaves behind', () => {
  it('records the attempt before rethrowing, so the retry reads a changed database', async () => {
    // The documented reason Temporal's own retry is usable here: same args, different context.
    db = await seeded([leaf()]);
    runAgentLoop.mockRejectedValue(new Error('model unreachable'));

    await expect(ExecuteLeafActivity({ leafId: 'leaf-1' })).rejects.toThrow('model unreachable');

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.status).toBe('failed');
    expect(saved.attempts?.[0]).toMatchObject({ attempt: 0, error: 'model unreachable' });
  });

  it('destroys the sandbox even when the run throws', async () => {
    // The pod holds CPU and memory; reaping is a safety net for crashes, not the normal path.
    db = await seeded([leaf()]);
    runAgentLoop.mockRejectedValue(new Error('boom'));

    await expect(ExecuteLeafActivity({ leafId: 'leaf-1' })).rejects.toThrow();

    expect(workspace.destroy).toHaveBeenCalledWith('leaf-1');
  });

  it('treats a leaf deleted mid-flight as normal, not as a failure to retry', async () => {
    db = await seeded([]);

    const result = await ExecuteLeafActivity({ leafId: 'gone' });

    expect(result.summary).toMatch(/no longer exists/);
    expect(resolveBaseUrl).not.toHaveBeenCalled();
  });
});

describe('personas on a leaf', () => {
  const withPersona = async (leafOver: Partial<Leaf>, personas: any[], profile?: Record<string, unknown>) => {
    const fresh = await seeded([leaf(leafOver)], profile);
    for (const p of personas) await fresh.savePersona(p);
    return fresh;
  };

  const reviewer = {
    id: 'persona-1', ownerId: 'u1', name: 'Reviewer',
    systemPrompt: 'You are terse and you review.',
    overrides: { temperature: 0.1 },
    createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z',
  };

  it('runs a leaf under its assigned persona', async () => {
    // personaId has existed since the board did and was read by nothing.
    db = await withPersona({ personaId: 'persona-1' }, [reviewer]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const opts = runAgentLoop.mock.calls[0]![0];
    expect(opts.overrides).toMatchObject({ temperature: 0.1, systemPrompt: 'You are terse and you review.' });
  });

  it('lets the persona beat the adopted default, since assigning one is the more specific act', async () => {
    db = await withPersona({ personaId: 'persona-1' }, [reviewer], { temperature: 0.9, think: true });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const opts = runAgentLoop.mock.calls[0]![0];
    expect(opts.overrides.temperature).toBe(0.1);
    // Everything the persona did not speak to still comes from the profile.
    expect(opts.overrides.think).toBe(true);
  });

  it('runs with no persona when the id dangles, rather than failing', async () => {
    // Deleting a persona must not break the leaves that already ran under it.
    db = await withPersona({ personaId: 'deleted' }, [], { temperature: 0.9 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0].overrides).toMatchObject({ temperature: 0.9 });
  });

  it('will not run a leaf under another user’s persona', async () => {
    // getPersonas returns every user's; the filter is the only thing keeping them apart.
    db = await withPersona({ personaId: 'persona-1' }, [{ ...reviewer, ownerId: 'someone-else' }]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0].overrides.systemPrompt).toBeUndefined();
  });
});
