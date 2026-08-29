import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import type { Leaf } from '../lib/leaves.js';

const resolveBaseUrl = vi.fn();
const readStreamedReply = vi.fn();
const fetchMock = vi.fn();

let db: MemoryDB;

vi.mock('../lib/db-interface.js', () => ({ createDatabase: () => db }));
vi.mock('../lib/model-wiring.js', () => ({ createModelService: () => ({ resolveBaseUrl }) }));
vi.mock('../lib/agent-loop.js', () => ({ readStreamedReply }));
vi.stubGlobal('fetch', fetchMock);

const { JudgeLeafActivity } = await import('./JudgeLeafActivity.js');

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'leaf-1', ownerId: 'u1', branchId: 'b1', title: 'Add a rate limiter',
  status: 'succeeded', verified: false, column: 'review', depth: 0, blocking: true,
  createdAt: '2026-08-21T00:00:00Z', updatedAt: '2026-08-21T00:00:00Z',
  ...over,
} as Leaf);

const DIFF = '+const bucket = new TokenBucket(100);\n+// TODO: wire the middleware in';

const seeded = async (records: Leaf[], evidence?: any) => {
  const fresh = new MemoryDB();
  await fresh.init();
  for (const l of records) await fresh.saveLeaf(l);
  if (evidence) {
    await fresh.saveLeafTrace({
      id: 'leaf-1', ownerId: 'u1', branchId: 'b1', steps: [],
      totalSteps: 1, tokensUsed: 10, createdAt: 'now',
    } as any);
    await fresh.saveLeafEvidence('leaf-1', evidence);
  }
  (fresh as any).init = async () => undefined;
  (fresh as any).close = async () => undefined;
  return fresh;
};

const replied = (content: string) => {
  fetchMock.mockResolvedValue({ ok: true } as any);
  readStreamedReply.mockResolvedValue({ content, reasoning: '', toolCalls: [], tokens: 10, completionTokens: 5 });
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveBaseUrl.mockResolvedValue({ provider: { id: 'd1', name: 'Tabby', model: 'Qwen3-32B' }, baseUrl: 'http://model' });
});

const review = async () => (await db.getLeaves()).find((l) => l.id === 'leaf-1')!.review;

describe('what the judge writes', () => {
  it('records a verdict with the quote that earned it', async () => {
    db = await seeded([leaf()], { capturedAt: 'now', diff: DIFF });
    replied(JSON.stringify({
      dimensions: [{ name: 'no_stubs', verdict: 'unsound', quote: '// TODO: wire the middleware in', why: 'left as a stub' }],
    }));

    const out = await JudgeLeafActivity({ leafId: 'leaf-1' });

    expect(out.verdict).toBe('unsound');
    expect((await review())?.dimensions?.[0]?.quote).toContain('TODO: wire the middleware');
  });

  it('never touches status, verified or merged', async () => {
    db = await seeded([leaf({ status: 'succeeded', verified: false })], { capturedAt: 'now', diff: DIFF });
    replied(JSON.stringify({ dimensions: [{ name: 'x', verdict: 'unsound', quote: '// TODO: wire the middleware in', why: 'y' }] }));

    await JudgeLeafActivity({ leafId: 'leaf-1' });

    const after = (await db.getLeaves()).find((l) => l.id === 'leaf-1')!;
    expect(after.status).toBe('succeeded');
    expect(after.verified).toBe(false);
    expect(after.merged).toBeUndefined();
  });
});

describe('which leaves it will look at', () => {
  it('refuses a verified leaf without calling a model', async () => {
    db = await seeded([leaf({ verified: true })], { capturedAt: 'now', diff: DIFF });

    const out = await JudgeLeafActivity({ leafId: 'leaf-1' });

    expect(out.verdict).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await review()).toBeUndefined();
  });

  it('refuses a failed leaf', async () => {
    db = await seeded([leaf({ status: 'failed' })], { capturedAt: 'now', diff: DIFF });
    expect((await JudgeLeafActivity({ leafId: 'leaf-1' })).verdict).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('when it cannot answer', () => {
  it('says so rather than forming an opinion on nothing', async () => {
    db = await seeded([leaf()]);

    const out = await JudgeLeafActivity({ leafId: 'leaf-1' });

    expect(out.verdict).toBe('unavailable');
    expect((await review())?.reason).toMatch(/no evidence/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to unavailable when the model throws, and writes nothing', async () => {
    db = await seeded([leaf()], { capturedAt: 'now', diff: DIFF });
    fetchMock.mockRejectedValue(new Error('endpoint down'));

    const out = await JudgeLeafActivity({ leafId: 'leaf-1' });

    expect(out.verdict).toBe('unavailable');
    expect(await review()).toBeUndefined();
  });

  it('degrades when the model returns nonsense', async () => {
    db = await seeded([leaf()], { capturedAt: 'now', diff: DIFF });
    replied('I am unable to review this.');

    expect((await JudgeLeafActivity({ leafId: 'leaf-1' })).verdict).toBe('unavailable');
  });

  it('reaches no verdict when every finding was fabricated', async () => {
    db = await seeded([leaf()], { capturedAt: 'now', diff: DIFF });
    replied(JSON.stringify({
      dimensions: [{ name: 'x', verdict: 'unsound', quote: 'throw new Error("not implemented")', why: 'stubbed' }],
    }));

    expect((await JudgeLeafActivity({ leafId: 'leaf-1' })).verdict).toBe('unavailable');
  });
});
