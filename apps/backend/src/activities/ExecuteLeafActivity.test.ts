import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import type { Leaf } from '../lib/leaves.js';

import { seedTreeTypes } from '../lib/tree-types.js';
import { seedWorkspaceImages } from '../lib/workspace-image-seeds.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from '../lib/workspace-image-seeds.js';
import { seedsByLanguage as BY_LANGUAGE } from '../lib/workspace-image-seeds.js';
import { seedPacks } from '../lib/pack-seeds.js';
import { seedPersonas } from '../lib/persona-seeds.js';

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

const seeded = async (records: Leaf[], profile?: Record<string, unknown>) => {
  const fresh = new MemoryDB();
  await fresh.init();
  // The budget is the pack's, so a run needs the shipped packs present.
  await seedPersonas(fresh);
  await seedPacks(fresh);
  for (const l of records) await fresh.saveLeaf(l);
  if (profile) {
    await fresh.saveHarnessProfile({
      ownerId: 'u1',
      overrides: profile,
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as any);
  }
  (fresh as any).init = async () => undefined;
  (fresh as any).close = async () => undefined;
  return fresh;
};

beforeEach(() => {
  vi.clearAllMocks();
  runAgentLoop.mockReset();
  resolveBaseUrl.mockResolvedValue({
    provider: { id: 'dep-1', name: 'Tabby', model: 'Qwen3-32B', kind: 'tabbyapi' },
    baseUrl: 'http://model',
  });
  runAgentLoop.mockResolvedValue({
    succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [],
  });
});

describe('what a leaf is recorded as having consumed', () => {
  it('records exactly what the run reported, not a multiple of it', async () => {
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.tokens).toBe(120);
  });

  it('accumulates across attempts, because a retry costs real money too', async () => {
    db = await seeded([leaf({ usage: { tokens: 120, completionTokens: 30, workspaces: 1 } })]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.tokens).toBe(240);
  });

  it('counts the sandbox it stood up, so maxWorkspaces can trip at all', async () => {
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.workspaces).toBe(1);
  });

  it('records generated tokens separately from billed ones', async () => {
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.completionTokens).toBe(30);
  });

  it('degrades a missing count to zero rather than to NaN', async () => {
    runAgentLoop.mockResolvedValue({ succeeded: true, summary: 'done', tokensUsed: 120, transcript: [] });
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.completionTokens).toBe(0);
    expect(Number.isNaN(saved.usage?.completionTokens)).toBe(false);
  });

  it('does not revert an edit made while the agent was working', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockImplementation(async () => {
      const live = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
      await db.saveLeaf({ ...live, title: 'Renamed while it ran' });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.title).toBe('Renamed while it ran');
    expect(saved.status).toBe('succeeded');
    expect(saved.usage?.tokens).toBe(120);
  });
});

describe('which model a leaf runs against', () => {
  it('resolves the promoted model, so adopting one reaches real work', async () => {
    db = await seeded([leaf()], { model: 'dep-7', temperature: 0.2 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(resolveBaseUrl).toHaveBeenCalledWith('u1', 'dep-7', undefined);
  });

  it('leaves the choice open when nothing has been promoted', async () => {
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(resolveBaseUrl).toHaveBeenCalledWith('u1', undefined, undefined);
  });

  it('ignores a promoted model that is not a string, rather than resolving nonsense', async () => {
    db = await seeded([leaf()], { model: 42 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(resolveBaseUrl).toHaveBeenCalledWith('u1', undefined, undefined);
  });

  it('sends the provider’s served model, never the id it was selected by', async () => {
    db = await seeded([leaf()], { model: 'dep-1' });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0]).toMatchObject({ model: 'Qwen3-32B', kind: 'tabbyapi' });
  });

  it('still hands the rest of the adopted profile to the loop', async () => {
    db = await seeded([leaf()], { model: 'dep-7', temperature: 0.2, maxSteps: 9 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0].overrides).toMatchObject({ temperature: 0.2, maxSteps: 9 });
  });
});

describe('what a leaf leaves behind', () => {
  it('records the attempt before rethrowing, so the retry reads a changed database', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockRejectedValue(new Error('model unreachable'));

    await expect(ExecuteLeafActivity({ leafId: 'leaf-1' })).rejects.toThrow('model unreachable');

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.attempts?.[0]).toMatchObject({ attempt: 0, error: 'model unreachable' });
    expect(saved.status).toBe('running');
  });

  it('destroys the sandbox even when the run throws', async () => {
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
  const withPersona = async (leafOver: Partial<Leaf>, packs: any[], profile?: Record<string, unknown>) => {
    const fresh = await seeded([leaf(leafOver)], profile);
    for (const p of packs) {
      await fresh.savePersonaPack(p);
      await fresh.savePersona({
        id: p.personaId, ownerId: p.ownerId, name: p.name, systemPrompt: p.systemPrompt,
        createdAt: p.createdAt, updatedAt: p.updatedAt,
      } as never);
    }
    return fresh;
  };

  const reviewer = {
    id: 'persona-1', ownerId: 'u1', slug: 'reviewer', name: 'Reviewer',
    personaId: 'rev-persona', tools: [],
    systemPrompt: 'You are terse and you review.',
    overrides: { temperature: 0.1 },
    createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z',
  };

  it('runs a leaf under its assigned persona', async () => {
    db = await withPersona({ packId: 'persona-1' }, [reviewer]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const opts = runAgentLoop.mock.calls[0]![0];
    expect(opts.overrides).toMatchObject({ temperature: 0.1, systemPrompt: 'You are terse and you review.' });
  });

  it('lets the persona beat the adopted default, since assigning one is the more specific act', async () => {
    db = await withPersona({ packId: 'persona-1' }, [reviewer], { temperature: 0.9, think: true });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const opts = runAgentLoop.mock.calls[0]![0];
    expect(opts.overrides.temperature).toBe(0.1);
    expect(opts.overrides.think).toBe(true);
  });

  it('runs with no persona when the id dangles, rather than failing', async () => {
    db = await withPersona({ packId: 'deleted' }, [], { temperature: 0.9 });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0].overrides).toMatchObject({ temperature: 0.9 });
  });

  it('will not run a leaf under another user’s persona', async () => {
    db = await withPersona({ packId: 'persona-1' }, [{ ...reviewer, ownerId: 'someone-else' }]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect(runAgentLoop.mock.calls[0]![0].overrides.systemPrompt).toBeUndefined();
  });
});

describe('what a finished leaf leaves to read', () => {
  it('stores the summary, not just returns it', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockResolvedValue({
      succeeded: true, summary: 'Air quality tomorrow is Moderate (AQI 62).', tokensUsed: 120, transcript: [],
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.summary).toMatch(/Moderate/);
  });

  it('moves a finished leaf out of To Do', async () => {
    db = await seeded([leaf({ column: 'todo' })]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect((await db.getLeaves())[0]!.column).toBe('review');
  });
});

describe('saving a leaf partway through', () => {
  const researcher = {
    id: 'p-res', ownerId: 'u1', slug: 'researcher', name: 'Researcher',
    personaId: 'res-persona', tools: [], overrides: {},
    workspace: { output: '/work/findings.md', requireSources: false },
    createdAt: 'x', updatedAt: 'x',
  };

  const GOOD_FINDINGS = `# Findings\n\n${'The service records an audit entry for every state change, which the team confirmed. '.repeat(8)}`;

  const withOneCheckpoint = async (findings = GOOD_FINDINGS) => {
    let saved: any;
    workspace.readFile.mockResolvedValue(findings);
    runAgentLoop.mockImplementation(async (o: any) => {
      saved = await o.checkpoint?.({ number: 1, handoff: { done: 'd', next: 'n' }, tokensUsed: 100, maxTokens: 300 });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });
    db = await seeded([leaf({ packId: 'p-res' })]);
    await db.savePersonaPack(researcher as any);
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    return { saved, record: (await db.getLeaves()).find((l) => l.id === 'leaf-1')! };
  };

  it('hands the loop a driver it can actually call', async () => {
    const { saved } = await withOneCheckpoint();
    expect(saved?.artifact).toBeTruthy();
  });

  it('writes the agent’s handoff into the artifact it saves', async () => {
    const { saved } = await withOneCheckpoint();
    expect(saved.artifact).toContain('What it says comes next');
  });

  it('persists the deliverable immediately, not at the end of the run', async () => {
    const { record } = await withOneCheckpoint();
    expect(record.findings).toContain('audit entry for every state change');
  });

  it('reports which check the deliverable currently fails', async () => {
    const { saved } = await withOneCheckpoint('too short');
    expect(saved.artifact).toContain(researcher.workspace.output);
    expect(saved.artifact).toMatch(/unverified|failed/);
  });

  it('still produces an artifact when the deliverable cannot be read', async () => {
    let threw = false;
    let saved: any;
    workspace.readFile.mockRejectedValue(new Error('sandbox gone'));
    runAgentLoop.mockImplementation(async (o: any) => {
      saved = await o.checkpoint?.({ number: 1, handoff: { done: 'd', next: 'n' }, tokensUsed: 100, maxTokens: 300 })
        .catch(() => { threw = true; return undefined; });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });
    db = await seeded([leaf({ packId: 'p-res' })]);
    await db.savePersonaPack(researcher as any);
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);

    expect(threw).toBe(false);
    expect(saved.artifact).toContain('0 characters');
    expect(saved.artifact).toContain('What it says comes next');
  });

  it('saves nothing when there is nowhere durable to save it', async () => {
    let saved: any = 'unset';
    runAgentLoop.mockImplementation(async (o: any) => {
      saved = await o.checkpoint?.({ number: 1, tokensUsed: 100, maxTokens: 300 });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });
    expect(saved).toBeUndefined();
  });
});

describe('what a run is allowed to write down', () => {
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz012345';

  it('redacts a credential the agent echoed into a step', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockImplementation(async (o: any) => {
      o.onStep?.({ step: 1, reasoning: `using ${TOKEN}`, toolCalls: [], toolResults: [], tokens: 10 });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const trace = await db.getLeafTrace('leaf-1');
    expect(JSON.stringify(trace)).not.toContain(TOKEN);
    expect(JSON.stringify(trace)).toContain('[redacted]');
  });

  it('redacts the summary, which a human reads', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockResolvedValue({
      succeeded: true, summary: `pushed with ${TOKEN}`, tokensUsed: 120, completionTokensUsed: 30, transcript: [],
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.summary).not.toContain(TOKEN);
  });

  it('redacts the recorded failure, which the NEXT attempt reads', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockRejectedValue(new Error(`clone failed for https://koala:${TOKEN}@gitea.local/x.git`));

    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(JSON.stringify(saved.attempts)).not.toContain(TOKEN);
  });

  it('leaves an ordinary run completely untouched', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockImplementation(async (o: any) => {
      o.onStep?.({ step: 1, reasoning: 'writing src/clamp.js', toolCalls: [], toolResults: [], tokens: 10 });
      return { succeeded: true, summary: 'Created src/clamp.js and committed it.', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.summary).toBe('Created src/clamp.js and committed it.');
    expect(JSON.stringify(await db.getLeafTrace('leaf-1'))).toContain('writing src/clamp.js');
  });
});

describe('when the run diagnoses itself', () => {
  const failing = (stoppedBecause: string) => {
    runAgentLoop.mockResolvedValue({
      succeeded: false,
      summary: 'The last 6 turns repeat the same thought 3 times. This is a loop, not progress.',
      stoppedBecause,
      tokensUsed: 200_000,
      completionTokensUsed: 4_000,
      transcript: ['web_search: OpenUI'],
    });
  };

  it('refuses another attempt when it says it is circling', async () => {
    db = await seeded([leaf()]);
    failing('circling');

    await expect(ExecuteLeafActivity({ leafId: 'leaf-1' })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'SelfDiagnosedStop',
    });
  });

  it('refuses another attempt when it stopped calling tools', async () => {
    db = await seeded([leaf()]);
    failing('silent');

    await expect(ExecuteLeafActivity({ leafId: 'leaf-1' })).rejects.toMatchObject({ nonRetryable: true });
  });

  it('STILL retries a run that merely ran out of budget', async () => {
    db = await seeded([leaf()]);
    failing('budget');

    await expect(ExecuteLeafActivity({ leafId: 'leaf-1' })).rejects.not.toMatchObject({ nonRetryable: true });
  });

  it('records WHY on the leaf, which used to be blank on every failure', async () => {
    db = await seeded([leaf()]);
    failing('circling');

    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1');
    expect(saved?.summary).toMatch(/loop, not progress/);
  });
});

describe('what the tree type decides', () => {
  const onTree = async (type: string, personaScope: Record<string, unknown> = {}) => {
    db = await seeded([leaf({ branchId: 'b1', packId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type, projectIds: [] } as never);
    await db.savePersonaPack({
      id: 'p1', ownerId: 'u1', slug: 'p1', name: 'Worker', personaId: 'p1-persona', tools: [], overrides: {},
      workspace: personaScope, createdAt: 'x', updatedAt: 'x',
    } as never);
    await seedTreeTypes(db);
    await seedWorkspaceImages(db);
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    return (workspace.create.mock.calls[0] as unknown[] | undefined)?.[0] as { image?: string } | undefined;
  };

  it('takes the workspace image from the type, not from the leaf or the persona', async () => {
    const spec = await onTree('dataset');
    expect(spec?.image).toBe(BY_LANGUAGE.python.image);
  });

  it('lets a prose type keep its minimal image when there is no checkout', async () => {
    const spec = await onTree('research-paper', { tools: [] });
    expect(spec?.image).toBe(BY_LANGUAGE.base.image);
  });

  it('upgrades that image once the leaf actually clones', async () => {
    const spec = await onTree('research-paper', { repo: true });
    expect(spec?.image).not.toBe(BY_LANGUAGE.base.image);
  });
});

describe('the verify command follows the same language as the workspace', () => {
  const verifyOn = async (language: string, personaScope: Record<string, unknown> = { repo: true }) => {
    db = await seeded([leaf({ branchId: 'b1', packId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersonaPack({
      id: 'p1', ownerId: 'u1', slug: 'p1', name: 'Worker', personaId: 'p1-persona', tools: [], overrides: {},
      workspace: personaScope, createdAt: 'x', updatedAt: 'x',
    } as never);
    await db.saveTreeType({
      id: 'probe', ownerId: 'u1', label: 'Probe', summary: 's',
      language, produces: 'service', doneMeans: 'it runs', files: [],
    } as never);
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    const ran = (workspace.exec.mock.calls as unknown[][]).map((c) => String(c[1] ?? ''));
    return ran.find((c) => /--test|unittest|pytest|go test/.test(c));
  };

  it('uses the python runner on a python type', async () => {
    expect(await verifyOn('python')).toMatch(/unittest|pytest/);
  });

  it('uses the node runner on a node type', async () => {
    expect(await verifyOn('node')).toMatch(/node --test/);
  });

  it('still lets a persona override it', async () => {
    expect(await verifyOn('python', { repo: true, language: 'node' })).toMatch(/node --test/);
  });
});

describe('validationRecipe evaluates during post-run verification and enables merge', () => {
  it('runs validation recipe checks during post-run verification', async () => {
    db = await seeded([leaf({ branchId: 'b1', packId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersonaPack({ id: 'p1', ownerId: 'u1', slug: 'p1', name: 'Worker', personaId: 'p1-persona', tools: [], overrides: {}, workspace: { repo: true }, createdAt: 'x', updatedAt: 'x' } as never);
    await db.saveTreeType({
      id: 'probe', ownerId: 'u1', label: 'Probe', summary: 's',
      language: 'node', produces: 'service', doneMeans: 'it runs', files: [],
      validationRecipe: {
        recipeId: 'test-recipe',
        checks: [{ id: 'build-check', name: 'Build', type: 'run-command', command: 'npm run build' }],
      },
    } as never);

    workspace.exec.mockResolvedValue({ exitCode: 0, stdout: 'Build success', stderr: '' });
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    const ran = (workspace.exec.mock.calls as unknown[][]).map((c) => String(c[1] ?? ''));
    expect(ran.some((c) => c.includes('npm run build'))).toBe(true);
  });
});

describe('worker <-> validator iterative loop', () => {
  it('hands failing validation back to worker and succeeds when resolved on next round', async () => {
    db = await seeded([leaf({ branchId: 'b1', packId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersonaPack({ id: 'p1', ownerId: 'u1', slug: 'p1', name: 'Worker', personaId: 'p1-persona', tools: [], overrides: {}, workspace: { repo: true }, createdAt: 'x', updatedAt: 'x' } as never);
    await db.saveTreeType({
      id: 'probe', ownerId: 'u1', label: 'Probe', summary: 's',
      language: 'node', produces: 'service', doneMeans: 'it runs', files: [],
      validationRecipe: {
        recipeId: 'test-recipe',
        checks: [{ id: 'build-check', name: 'Build', type: 'run-command', command: 'npm run build' }],
      },
    } as never);

    let roundCount = 0;
    const receivedPrompts: string[] = [];
    runAgentLoop.mockImplementation(async (opts: any) => {
      roundCount++;
      receivedPrompts.push(opts.taskContext);
      return { succeeded: true, summary: `Completed round ${roundCount}`, tokensUsed: 100, trace: [] };
    });

    (workspace.exec as any).mockImplementation(async (_id: string, cmd: string) => {
      if (cmd.includes('npm run build')) {
        if (roundCount === 1) {
          return { exitCode: 1, stdout: '', stderr: 'TS2307: Cannot find module zod' };
        }
        return { exitCode: 0, stdout: 'Build completed cleanly', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);

    expect(roundCount).toBe(2);
    expect(receivedPrompts[1]).toContain('Validation Feedback (Round 1 of 4)');
    expect(receivedPrompts[1]).toContain('TS2307: Cannot find module zod');

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1');
    expect(saved?.verified).toBe(true);
    expect(saved?.checks?.verify?.outcome).toBe('passed');
  });

  it('recovers when worker circles in round 1 after making changes and fixes in round 2', async () => {
    db = await seeded([leaf({ branchId: 'b1', packId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersonaPack({ id: 'p1', ownerId: 'u1', slug: 'p1', name: 'Worker', personaId: 'p1-persona', tools: [], overrides: {}, workspace: { repo: true }, createdAt: 'x', updatedAt: 'x' } as never);
    await db.saveTreeType({
      id: 'probe', ownerId: 'u1', label: 'Probe', summary: 's',
      language: 'node', produces: 'service', doneMeans: 'it runs', files: [],
      validationRecipe: {
        recipeId: 'test-recipe',
        checks: [{ id: 'build-check', name: 'Build', type: 'run-command', command: 'npm run build' }],
      },
    } as never);

    let roundCount = 0;
    const receivedPrompts: string[] = [];
    runAgentLoop.mockImplementation(async (opts: any) => {
      roundCount++;
      receivedPrompts.push(opts.taskContext);
      if (roundCount === 1) {
        return { succeeded: false, stoppedBecause: 'circling', summary: 'circling on grep', tokensUsed: 100, trace: [] };
      }
      return { succeeded: true, summary: 'Fixed in round 2', tokensUsed: 100, trace: [] };
    });

    (workspace.exec as any).mockImplementation(async (_id: string, cmd: string) => {
      if (cmd.includes('rev-list --count')) {
        return { exitCode: 0, stdout: '1\n', stderr: '' };
      }
      if (cmd.includes('diff --name-only') || cmd.includes('status --porcelain')) {
        return { exitCode: 0, stdout: ' M index.js\n', stderr: '' };
      }
      if (cmd.includes('npm run build')) {
        if (roundCount === 1) {
          return { exitCode: 1, stdout: '', stderr: 'Tool gitea-list-repos expected a Zod schema' };
        }
        return { exitCode: 0, stdout: 'Build completed cleanly', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);

    expect(roundCount).toBe(2);
    expect(receivedPrompts[1]).toContain('Validation Feedback (Round 1 of 4)');
    expect(receivedPrompts[1]).toContain('Tool gitea-list-repos expected a Zod schema');

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1');
    expect(saved?.verified).toBe(true);
    expect(saved?.checks?.verify?.outcome).toBe('passed');
  });

  it('does not run tree code validation recipe on document/framing packs', async () => {
    db = await seeded([leaf({ branchId: 'b1', packId: 'p-framer' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'api-service', projectIds: [] } as never);
    await db.savePersonaPack({
      id: 'p-framer', ownerId: 'u1', slug: 'framer', name: 'Framer', personaId: 'framer-persona', tools: [], overrides: {},
      workspace: { repo: false, output: '/work/questions.md', requireSources: false },
      createdAt: 'x', updatedAt: 'x',
    } as never);
    await db.saveTreeType({
      id: 'api-service', ownerId: 'u1', label: 'API Service', summary: 's',
      language: 'node', produces: 'service', doneMeans: 'it runs', files: [],
      validationRecipe: {
        recipeId: 'node-service',
        checks: [{ id: 'jest-tests', name: 'Unit tests', type: 'run-command', command: 'npm test' }],
      },
    } as never);

    runAgentLoop.mockResolvedValue({
      succeeded: true,
      summary: 'Wrote architecture and questions',
      tokensUsed: 100,
      trace: [],
    });

    const goodDoc = '# Questions\n\n' + 'The following questions must be answered for implementation, as confirmed by the team. '.repeat(10);
    workspace.readFile.mockResolvedValue(goodDoc);

    const ranCommands: string[] = [];
    (workspace.exec as any).mockImplementation(async (_id: string, cmd: string) => {
      ranCommands.push(cmd);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1');

    expect(ranCommands.some((c) => c.includes('npm test'))).toBe(false);

    expect(saved?.verified).toBe(true);
    expect(saved?.checks?.verify?.outcome).toBe('passed');
  });
});
