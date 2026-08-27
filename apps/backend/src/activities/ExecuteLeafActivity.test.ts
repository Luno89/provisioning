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
import { WORKSPACE_IMAGES } from '../lib/workspace-spec.js';
import { seedTreeTypes } from '../lib/tree-types.js';

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
  /**
   * ── THE DOUBLE COUNT ──
   * This activity folds `run.tokensUsed` into the leaf and persists it on BOTH exit paths. The
   * workflow ALSO called UpdateLeafActivity with the returned total, and that call adds rather than
   * replaces — so every succeeded leaf was recorded at roughly twice its real cost, while a failed
   * attempt (which throws, and never returns a result to add) was recorded once. The Personas
   * "Typical tokens" column reported the doubled figure.
   *
   * Pinned here rather than in the workflow because this is the writer that must stay authoritative:
   * it is the only one that sees a failed attempt.
   */
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

  /**
   * `workspaces` was declared, aggregated, and compared against `maxWorkspaces` — and incremented
   * by nothing, anywhere. The ceiling could never trip, which reads exactly like a ceiling that
   * was never reached.
   */
  it('counts the sandbox it stood up, so maxWorkspaces can trip at all', async () => {
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.workspaces).toBe(1);
  });

  /**
   * Billed tokens and generated tokens are different facts. `tokens` re-counts the whole prompt
   * every turn, so it says what a leaf COST; only this one says what it produced.
   */
  it('records generated tokens separately from billed ones', async () => {
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.completionTokens).toBe(30);
  });

  /**
   * NaN is the dangerous failure, not a wrong number: it propagates through aggregateUsage to the
   * whole subtree, and every budgetExceeded comparison against NaN is false — so one undefined
   * addend silently turns the budget OFF rather than looking broken.
   */
  it('degrades a missing count to zero rather than to NaN', async () => {
    runAgentLoop.mockResolvedValue({ succeeded: true, summary: 'done', tokensUsed: 120, transcript: [] });
    db = await seeded([leaf()]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.usage?.completionTokens).toBe(0);
    expect(Number.isNaN(saved.usage?.completionTokens)).toBe(false);
  });

  /**
   * ── THE STALE FULL REPLACE ──
   * The activity read its leaf once, at the top, and then ran for minutes. `saveLeaf` is a full
   * replace, so spreading that object at the end reverted anything a human changed in between —
   * silently, and only on leaves that finished, which is the half nobody goes back to check.
   *
   * The catch path already re-read for exactly this reason; the two success-shaped paths did not.
   */
  it('does not revert an edit made while the agent was working', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockImplementation(async () => {
      // Stands in for a human renaming the leaf in the UI mid-run.
      const live = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
      await db.saveLeaf({ ...live, title: 'Renamed while it ran' });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.title).toBe('Renamed while it ran');
    // …and the run's own result still landed, so the re-read did not cost the write it guards.
    expect(saved.status).toBe('succeeded');
    expect(saved.usage?.tokens).toBe(120);
  });
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
    expect(saved.attempts?.[0]).toMatchObject({ attempt: 0, error: 'model unreachable' });
    /**
     * Still RUNNING, because Temporal is about to try again.
     *
     * This asserted `failed` and was right about the old behaviour and wrong about the world: a
     * leaf that failed twice and succeeded on the third showed a red failed icon for most of its
     * life. The attempt is recorded either way — that is what LeafDetail lists — but the status a
     * person's eye lands on now distinguishes "failed" from "failed, trying again".
     */
    expect(saved.status).toBe('running');
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

describe('what a finished leaf leaves to read', () => {
  it('stores the summary, not just returns it', async () => {
    // A leaf ran for two minutes, spent 144,000 tokens, reported success — and left nothing on the
    // board. The summary went to the workflow result, which lands in Temporal history and nowhere
    // a person looks.
    db = await seeded([leaf()]);
    runAgentLoop.mockResolvedValue({
      succeeded: true, summary: 'Air quality tomorrow is Moderate (AQI 62).', tokensUsed: 120, transcript: [],
    });

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(saved.summary).toMatch(/Moderate/);
  });

  it('moves a finished leaf out of To Do', async () => {
    // Finished work is not still To Do. The workflow then writes its own stale column over this —
    // fixed in LeafWorkflow, which has no unit harness, so this pins the activity's half.
    db = await seeded([leaf({ column: 'todo' })]);

    await ExecuteLeafActivity({ leafId: 'leaf-1' });

    expect((await db.getLeaves())[0]!.column).toBe('review');
  });
});

/**
 * Checkpoints, from the activity's side.
 *
 * The loop decides when; this decides how, and everything that can go wrong here is about state
 * that outlives the pod. The mocked loop below simply invokes whatever driver it was handed, which
 * is exactly the seam worth testing: the driver is where the workspace, the git scripts and Mongo
 * all meet.
 */
describe('saving a leaf partway through', () => {
  /**
   * A persona whose deliverable is a FILE rather than a checkout — Researcher, Framer, Synthesist.
   *
   * Exercised here rather than the repository path because it needs no Gitea, no project and no
   * checkout credential, and because it is the path that would otherwise get no coverage at all:
   * the git half is script-shaped and is asserted directly in leaf-checkout.test.ts.
   */
  const researcher = {
    id: 'p-res', ownerId: 'u1', name: 'Researcher',
    scope: { output: '/work/findings.md', requireSources: false },
    createdAt: 'x', updatedAt: 'x',
  };

  /**
   * A findings file that actually passes assessFindings: enough prose, no placeholders. The
   * activity VERIFIES the deliverable at the end and throws when it is empty, so without this the
   * helper would never return and every assertion here would be about the wrong failure.
   */
  const GOOD_FINDINGS = `# Findings\n\n${'The service records an audit entry for every state change, which the team confirmed. '.repeat(8)}`;

  /** Runs the activity with a loop that fires one checkpoint, and hands back what the driver did. */
  const withOneCheckpoint = async (findings = GOOD_FINDINGS) => {
    let saved: any;
    workspace.readFile.mockResolvedValue(findings);
    runAgentLoop.mockImplementation(async (o: any) => {
      saved = await o.checkpoint?.({ number: 1, handoff: { done: 'd', next: 'n' }, tokensUsed: 100, maxTokens: 300 });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });
    db = await seeded([leaf({ personaId: 'p-res' })]);
    await db.savePersona(researcher as any);
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    return { saved, record: (await db.getLeaves()).find((l) => l.id === 'leaf-1')! };
  };

  it('hands the loop a driver it can actually call', async () => {
    const { saved } = await withOneCheckpoint();
    expect(saved?.artifact).toBeTruthy();
  });

  it('writes the agent’s handoff into the artifact it saves', async () => {
    const { saved } = await withOneCheckpoint();
    // The half only the agent knows — a diff cannot say what it meant to do next.
    expect(saved.artifact).toContain('What it says comes next');
  });

  /**
   * For a persona with no repository, `leaf.findings` IS the durable store — it is already written
   * on both exit paths and already fed back into the next attempt. Persisting it AT the checkpoint
   * rather than at the end is the whole point: a run killed after this line resumes from real work.
   */
  it('persists the deliverable immediately, not at the end of the run', async () => {
    const { record } = await withOneCheckpoint();
    expect(record.findings).toContain('audit entry for every state change');
  });

  it('reports which check the deliverable currently fails', async () => {
    // Better than a git summary would be: it names the gap rather than describing the diff.
    const { saved } = await withOneCheckpoint('too short');
    /**
     * Whatever the persona RECORD says, unchanged by the harness.
     *
     * The migration moves a document persona's `output` into the checkout; the run then uses the
     * path on the record. So what the Lab shows and what the leaf writes are the same string, and
     * this test asserts the fixture's own value rather than a rewrite.
     */
    expect(saved.artifact).toContain(researcher.scope.output);
    expect(saved.artifact).toMatch(/unverified|failed/);
  });

  it('still produces an artifact when the deliverable cannot be read', async () => {
    /**
     * A sandbox that will not answer is exactly when a save point matters most, so this degrades
     * rather than aborting: the artifact records an empty deliverable, which is a true and useful
     * statement, and the agent's handoff — the part that is not in any file — survives.
     *
     * What must never happen is the checkpoint throwing and taking the run with it.
     */
    let threw = false;
    let saved: any;
    workspace.readFile.mockRejectedValue(new Error('sandbox gone'));
    runAgentLoop.mockImplementation(async (o: any) => {
      saved = await o.checkpoint?.({ number: 1, handoff: { done: 'd', next: 'n' }, tokensUsed: 100, maxTokens: 300 })
        .catch(() => { threw = true; return undefined; });
      return { succeeded: true, summary: 'done', tokensUsed: 120, completionTokensUsed: 30, transcript: [] };
    });
    db = await seeded([leaf({ personaId: 'p-res' })]);
    await db.savePersona(researcher as any);
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);

    expect(threw).toBe(false);
    expect(saved.artifact).toContain('0 characters');
    // The agent's own account is not lost with the file.
    expect(saved.artifact).toContain('What it says comes next');
  });

  it('saves nothing when there is nowhere durable to save it', async () => {
    // No checkout and no declared output file: undefined means "did not save", and the loop then
    // carries on WITHOUT resetting — discarding a context whose replacement failed would lose the run.
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

/**
 * Credentials must not reach storage.
 *
 * The trace holds every command's stdout and `LeafEvidence` holds diffs and file contents, both
 * verbatim. The checkout credential is revoked at teardown so a stored copy is a dead string — but
 * the model's API key is not revoked, and neither is anything the agent found in the repository it
 * was handed.
 */
describe('what a run is allowed to write down', () => {
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz012345';

  it('redacts a credential the agent echoed into a step', async () => {
    db = await seeded([leaf()]);
    runAgentLoop.mockImplementation(async (o: any) => {
      // Stands in for `git remote -v`, an error message, or a command the model pasted back.
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
    // failureContext feeds this straight into the retry's prompt, so a credential here would be
    // handed back to a model rather than merely stored.
    db = await seeded([leaf()]);
    runAgentLoop.mockRejectedValue(new Error(`clone failed for https://koala:${TOKEN}@gitea.local/x.git`));

    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);

    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(JSON.stringify(saved.attempts)).not.toContain(TOKEN);
  });

  it('leaves an ordinary run completely untouched', async () => {
    // The other failure mode: a redactor that eats real content makes the record useless.
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

/**
 * ── A DIAGNOSIS IS NOT A TRANSIENT FAILURE ──
 *
 * Measured across two projects: nine leaves failed, every one was diagnosed correctly on its FIRST
 * attempt ("This is a loop, not progress"), and every one was then retried twice more and looped
 * again identically. One Synthesist recorded the same sentence three times. `barrenStreak` did not
 * catch any of them because they all produced something — a commit, a findings file.
 *
 * So producing output is not evidence that another attempt will differ. The loop's own verdict is.
 */
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
      // Temporal only stops retrying for a non-retryable failure; a plain Error is retried.
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
    /**
     * The other half, and the one that must not regress. A budget stop may go differently next
     * time — with checkpoints an attempt resumes and composes, which is what MAX_LEAF_ATTEMPTS is
     * for. Only a self-diagnosis is hopeless.
     */
    db = await seeded([leaf()]);
    failing('budget');

    await expect(ExecuteLeafActivity({ leafId: 'leaf-1' })).rejects.not.toMatchObject({ nonRetryable: true });
  });

  it('records WHY on the leaf, which used to be blank on every failure', async () => {
    // Nine failed leaves, nine `summary: (none)`. The reason existed in `attempts[].error`; the
    // field a human and the judge read did not have it.
    db = await seeded([leaf()]);
    failing('circling');

    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1');
    expect(saved?.summary).toMatch(/loop, not progress/);
  });
});

/**
 * ── THE TREE TYPE DECIDES THE WORKSPACE, NOT THE PERSONA ──
 *
 * `TREE_TYPES` declared `language` and `produces` from the day trees were introduced and NOTHING
 * read either, so the same decisions were made three other places: on the persona, in
 * `templateFor`'s switch, and in a `producesCode` check derived from `scope.output`. Three copies of
 * one fact is how a research tree ended up with an image that could not clone.
 */
describe('what the tree type decides', () => {
  const onTree = async (type: string, personaScope: Record<string, unknown> = {}) => {
    db = await seeded([leaf({ branchId: 'b1', personaId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type, projectIds: [] } as never);
    await db.savePersona({
      id: 'p1', ownerId: 'u1', name: 'Worker', systemPrompt: '', scope: personaScope,
    } as never);
    await seedTreeTypes(db, 'u1');
    await ExecuteLeafActivity({ leafId: 'leaf-1' }).catch(() => undefined);
    return (workspace.create.mock.calls[0] as unknown[] | undefined)?.[0] as { image?: string } | undefined;
  };

  it('takes the workspace image from the type, not from the leaf or the persona', async () => {
    // `dataset` declares python. The persona says nothing, and the leaf's own `language: 'node'` is
    // a legacy field — the type is what knows what the deliverable is written in.
    const spec = await onTree('dataset');
    expect(spec?.image).toBe(WORKSPACE_IMAGES.python.image);
  });

  it('lets a prose type keep its minimal image when there is no checkout', async () => {
    // `research-paper` honestly says `base`. A persona with no file tools takes no checkout, so
    // nothing requires git and the smallest image stands.
    const spec = await onTree('research-paper', { tools: [] });
    expect(spec?.image).toBe(WORKSPACE_IMAGES.base.image);
  });

  it('upgrades that image once the leaf actually clones', async () => {
    // Same type, same honest `base` — but a checkout needs git, satisfied from the catalogue.
    const spec = await onTree('research-paper', { repo: true });
    expect(spec?.image).not.toBe(WORKSPACE_IMAGES.base.image);
  });
});

/**
 * ── THE VERIFY COMMAND IS A FACT ABOUT THE CODE, NOT ABOUT THE ROLE ──
 *
 * `defaultVerifyCommand(persona?.scope?.language)` was the last copy of the decision the tree type
 * now owns. Measured on the first Python tree: the workspace correctly got `python-312` from the
 * type, and the same leaf was then handed the NODE default, because the Builder persona names no
 * language and `defaultVerifyCommand` falls back to `node`. A green `unittest` suite would have
 * been verified with `node --test` against no JS files at all.
 *
 * One resolved language, used for both. The persona may still override it — a Go persona working in
 * a Python repository is a real thing — but absent means "whatever this tree produces", the same
 * rule the image follows.
 */
describe('the verify command follows the same language as the workspace', () => {
  /**
   * Defines its own types rather than reaching for seeds, which is the point of types being data:
   * a test should be able to describe the situation it means. It also avoids the trap this test
   * fell into first — `dataset` declares `produces: 'artefact'`, so no verification runs on it at
   * all and the assertion failed for a reason that had nothing to do with language.
   */
  const verifyOn = async (language: string, personaScope: Record<string, unknown> = { repo: true }) => {
    db = await seeded([leaf({ branchId: 'b1', personaId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersona({ id: 'p1', ownerId: 'u1', name: 'Worker', systemPrompt: '', scope: personaScope } as never);
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
    // A Node persona working in a Python repository is a real thing; the record wins over the type.
    expect(await verifyOn('python', { repo: true, language: 'node' })).toMatch(/node --test/);
  });
});

describe('validationRecipe evaluates during post-run verification and enables merge', () => {
  it('runs validation recipe checks during post-run verification', async () => {
    db = await seeded([leaf({ branchId: 'b1', personaId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersona({ id: 'p1', ownerId: 'u1', name: 'Worker', systemPrompt: '', scope: { repo: true } } as never);
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
    db = await seeded([leaf({ branchId: 'b1', personaId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersona({ id: 'p1', ownerId: 'u1', name: 'Worker', systemPrompt: '', scope: { repo: true } } as never);
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

    // Assert that the worker ran two rounds
    expect(roundCount).toBe(2);
    // Round 2 must have received the Validator's diagnostic feedback
    expect(receivedPrompts[1]).toContain('Validation Feedback (Round 1 of 4)');
    expect(receivedPrompts[1]).toContain('TS2307: Cannot find module zod');

    // And the leaf must have settled as verified: true
    const saved = (await db.getLeaves()).find((l) => l.id === 'leaf-1');
    expect(saved?.verified).toBe(true);
    expect(saved?.checks?.verify?.outcome).toBe('passed');
  });

  it('recovers when worker circles in round 1 after making changes and fixes in round 2', async () => {
    db = await seeded([leaf({ branchId: 'b1', personaId: 'p1' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'probe', projectIds: [] } as never);
    await db.savePersona({ id: 'p1', ownerId: 'u1', name: 'Worker', systemPrompt: '', scope: { repo: true } } as never);
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

  it('does not run tree code validation recipe on document/framing personas', async () => {
    db = await seeded([leaf({ branchId: 'b1', personaId: 'p-framer' } as never)]);
    await db.saveBranch({ id: 'b1', ownerId: 'u1', treeId: 't1', title: 'T', messages: [] } as never);
    await db.saveTree({ id: 't1', ownerId: 'u1', name: 'T', type: 'api-service', projectIds: [] } as never);
    await db.savePersona({
      id: 'p-framer',
      ownerId: 'u1',
      name: 'Framer',
      systemPrompt: '',
      scope: { repo: false, output: '/work/questions.md', requireSources: false },
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

    // npm test from node-service recipe must NEVER have run against the Framer
    expect(ranCommands.some((c) => c.includes('npm test'))).toBe(false);

    // The leaf must be verified by assessFindings on questions.md
    expect(saved?.verified).toBe(true);
    expect(saved?.checks?.verify?.outcome).toBe('passed');
  });
});

