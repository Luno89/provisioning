/**
 * JudgeLeafActivity — reads what a leaf produced and says whether the claim holds up.
 *
 * ── THE HOLE THIS FILLS ──
 * Five deterministic layers check a leaf, and `leaf-verify.ts` is explicit that the bar they set is
 * "did the work happen", not "is it right". That is the correct stance and it leaves exactly one
 * gap: a leaf whose agent claimed success where nothing could check it. `decideStatus` falls back
 * to the claim there, on purpose, because most leaves are not test-shaped.
 *
 * ── WHY IT IS ITS OWN ACTIVITY ──
 * `ExecuteLeafActivity` is RETRIED, so an exception raised inside it retries the entire leaf — a
 * judge that threw would re-run the work it was meant to review. It is also already pressed against
 * a wall clock. Separate means the judge can fail without consequence, and can be re-run or
 * backfilled over historical leaves, which the calibration loop needs.
 *
 * ── AND WHY IT NEEDS NO SANDBOX ──
 * Everything it reads was captured before the pod was destroyed (lib/leaf-evidence.ts), so this
 * activity touches Mongo and a model endpoint and nothing else. That is what makes it cheap enough
 * to run on every unverified success rather than on a sample.
 *
 * ── WHAT IT MAY AND MAY NOT DO ──
 * It writes `leaf.review`. It never writes `status`, `verified` or `merged`. `verified` means a
 * deterministic check ran and passed; letting a model set it would destroy the claimed-versus-
 * verified distinction the rest of this codebase is built on. See lib/leaf-judge.ts for why its
 * scope makes overturning a green suite structurally impossible rather than merely forbidden.
 */
import { createDatabase } from '../lib/db-interface.js';
import type { Leaf } from '../lib/leaves.js';
import { createModelService } from '../lib/model-wiring.js';
import { readStreamedReply } from '../lib/agent-loop.js';
import { buildModelRequest } from '../lib/model-request.js';
import { fittedMaxTokens, THINKING_TURN_MAX_TOKENS } from '../lib/sampling.js';
import { resolveConfig } from '../lib/personas.js';
import { flattenPersona } from '../lib/persona-scope.js';
import { JUDGE_PERSONA } from '../lib/well-known-personas.js';
import { buildFailureNotice, withNotice } from '../lib/branch-notice.js';
import type { Branch } from '../lib/leaves.js';
import {
  buildJudgeBundle, buildJudgePrompt, parseJudgeReply, combineJudgement, shouldJudge,
  CODE_DIMENSIONS, RESEARCH_DIMENSIONS, type JudgeVerdict,
} from '../lib/leaf-judge.js';

export interface JudgeLeafArgs {
  leafId: string;
}

export interface JudgeLeafResult {
  leafId: string;
  verdict: JudgeVerdict;
}

/** A judge that has not answered in this long has stopped being cheaper than not having one. */
const JUDGE_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Judge exceeded ${ms / 1000}s`)), ms)),
  ]);
}

/**
 * Never throws, and never blocks a leaf.
 *
 * Every failure resolves to `unavailable` and writes nothing. `ResolveLandingActivity` states the
 * principle for this class of activity: it is a convenience over the manual path, not a replacement
 * for it — and a leaf whose judge was down is a leaf in exactly the state it was in before judges
 * existed.
 */
export async function JudgeLeafActivity(args: JudgeLeafArgs): Promise<JudgeLeafResult> {
  const db = createDatabase();
  await db.init();

  try {
    const leaf = (await db.getLeaves()).find((l: Leaf) => l.id === args.leafId);
    if (!leaf) return { leafId: args.leafId, verdict: 'unavailable' };

    /**
     * The scope check, again, at the point of execution.
     *
     * The workflow already asks before calling — but a leaf's status can change between the two,
     * and this is the check that makes "never shown a green suite" true rather than intended.
     */
    if (!shouldJudge(leaf)) return { leafId: args.leafId, verdict: 'unavailable' };

    const trace = await db.getLeafTrace(leaf.id);
    const evidence = trace?.evidence;
    if (!evidence || (!evidence.diff && !evidence.findings && !evidence.expects?.length)) {
      // Nothing was captured, so there is nothing to read. Saying so beats an opinion formed on air
      // — which is precisely the failure this whole design is built around.
      await record(db, leaf, { verdict: 'unavailable', at: new Date().toISOString(), reason: 'no evidence was captured' });
      return { leafId: args.leafId, verdict: 'unavailable' };
    }

    const ownPersonas = (await db.getPersonas()).filter((p: any) => p.ownerId === leaf.ownerId);
    const assigned = ownPersonas.find((p: any) => p.name === JUDGE_PERSONA);
    const persona = assigned ? flattenPersona(assigned, ownPersonas) : null;
    if (!assigned) console.warn(`[JudgeLeaf] no "${JUDGE_PERSONA}" persona — running with harness defaults`);

    const profile = await db.getHarnessProfile(leaf.ownerId).catch(() => null);
    const resolved = resolveConfig(profile, persona);
    const chosen = typeof resolved.overrides.model === 'string' ? resolved.overrides.model : undefined;

    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(leaf.ownerId, chosen);

    // Research leaves are asked different questions: there is no diff to read, only an answer.
    const dimensions = evidence.findings && !evidence.diff ? RESEARCH_DIMENSIONS : CODE_DIMENSIONS;
    const { bundle, dropped } = buildJudgeBundle({
      title: leaf.title,
      ...(leaf.body ? { body: leaf.body } : {}),
      ...(leaf.expects?.length ? { expects: leaf.expects } : {}),
      evidence,
    });
    if (dropped.length) console.log(`[JudgeLeaf] ${leaf.id}: bundle dropped ${dropped.join(', ')}`);

    const body = buildModelRequest({
      turn: 'conversation',
      ...(provider.kind ? { kind: provider.kind } : {}),
      messages: [
        ...(resolved.systemPrompt ? [{ role: 'system', content: resolved.systemPrompt }] : []),
        { role: 'user', content: buildJudgePrompt(bundle, dimensions) },
      ],
      stream: true,
      /**
       * ── SIZED FOR A MODEL THAT THINKS FIRST ──
       *
       * This was a bare 1,200 and the judge abstained on every leaf. The observed reply, captured
       * by the diagnostic below, began "We need answer user's request. Need produce JSON only. Need
       * review diff…" — reasoning, on the reasoning channel, with `content` empty. The model spent
       * its whole ceiling deliberating and never reached the answer.
       *
       * sampling.ts already records the rule: a thinking turn needs more "because the reasoning
       * pass consumes the budget before the answer starts". Doubling THINKING_TURN_MAX_TOKENS
       * rather than reusing it, because this turn also has to emit structured JSON afterwards — the
       * reasoning and the answer are two costs, not one.
       *
       * Fitted, because the bundle is up to MAX_BUNDLE_CHARS: a fixed ceiling that fits a small diff
       * is a hard 400 on a large one, which is the failure fittedMaxTokens exists for.
       */
      maxTokens: fittedMaxTokens(THINKING_TURN_MAX_TOKENS * 3, bundle.length, provider.contextTokens),
      ...(provider.model ? { model: provider.model } : {}),
      overrides: resolved.overrides,
    }).body;

    const res = await withTimeout(fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
    }), JUDGE_TIMEOUT_MS);

    if (!res.ok) {
      await record(db, leaf, { verdict: 'unavailable', at: new Date().toISOString(), reason: `model returned ${res.status}` });
      return { leafId: args.leafId, verdict: 'unavailable' };
    }

    const reply = await withTimeout(readStreamedReply(res as any), JUDGE_TIMEOUT_MS);

    /**
     * The answer, wherever the engine put it.
     *
     * A reasoning model emits its thinking on `reasoning_content` and its answer on `content`, and
     * not every engine separates them the way the spec implies — Koala's chat route streams both
     * channels for exactly this reason. An empty `content` means no answer was emitted on the
     * channel we asked about, and the JSON is very often sitting in the other one. Preferring
     * `content` keeps the normal case exact.
     */
    const answer = (reply.content ?? '').trim() || (reply.reasoning ?? '').trim();
    const { dimensions: kept, fabricated } = parseJudgeReply(answer, bundle);

    /**
     * Say what it actually said when nothing survived.
     *
     * "The judge reached no verdict" is unactionable on its own — it cannot distinguish a model
     * that refused, one that answered in prose, and one whose every quote was invented. Measured:
     * the first live run logged exactly that and the reply had to be reconstructed by hand.
     * Truncated, because this is a diagnostic and not a transcript.
     */
    if (!kept.length) {
      console.warn(
        `[JudgeLeaf] ${leaf.id}: no usable findings (${fabricated} fabricated). `
        + `Reply began: ${answer.slice(0, 300).replace(/\s+/g, ' ') || '(empty)'}`,
      );
    }
    if (fabricated) {
      // Worth logging loudly: it is the single most useful signal about whether a judge is reading
      // its inputs, and the calibration loop measures the same thing deliberately.
      console.warn(`[JudgeLeaf] ${leaf.id}: discarded ${fabricated} finding(s) that quoted nothing in the evidence`);
    }

    const verdict = combineJudgement(kept);
    await record(db, leaf, {
      verdict,
      ...(kept.length ? { dimensions: kept } : {}),
      ...(provider.model ? { model: provider.model } : {}),
      at: new Date().toISOString(),
    });

    console.log(`[JudgeLeaf] ${leaf.id}: ${verdict}${kept.length ? ` (${kept.length} dimensions)` : ''}`);

    /**
     * Only an `unsound` verdict reaches the conversation.
     *
     * The decision recorded in index.ts for failure review applies here too: a conclusion rendered
     * only in a panel is a dead end, and the evidence belongs where it can be argued with. A
     * `concern` is not worth interrupting for, and a `sound` certainly is not.
     */
    if (verdict === 'unsound') {
      await postNotice(db, leaf, kept).catch((err: any) =>
        console.warn(`[JudgeLeaf] ${leaf.id}: could not post notice: ${err?.message}`));
    }

    return { leafId: args.leafId, verdict };
  } catch (err: any) {
    console.warn(`[JudgeLeaf] ${args.leafId}: unavailable — ${err?.message}`);
    return { leafId: args.leafId, verdict: 'unavailable' };
  } finally {
    await db.close();
  }
}

/**
 * Writes the verdict, and nothing else.
 *
 * Re-reads first: this activity runs after a leaf has been running for minutes and `saveLeaf` is a
 * full replace. The explicit field list below is the point — `status`, `verified` and `merged` are
 * absent because a model must never be able to set them.
 */
async function record(db: any, leaf: Leaf, review: NonNullable<Leaf['review']>): Promise<void> {
  const fresh = (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);
  if (!fresh) return;
  await db.saveLeaf({ ...fresh, review, updatedAt: new Date().toISOString() });
}

/** Puts the finding where the conversation is, with the quotes that earned it. */
async function postNotice(db: any, leaf: Leaf, dimensions: { name: string; quote: string; why: string }[]): Promise<void> {
  const branch = (await db.getBranches()).find((b: Branch) => b.id === leaf.branchId);
  if (!branch) return;

  const detail = dimensions
    .slice(0, 3)
    .map((d) => `- ${d.why}\n  > ${d.quote.split('\n')[0]}`)
    .join('\n');

  await db.saveBranch(withNotice(branch, buildFailureNotice(
    leaf.title,
    `Reviewed after it finished: the work does not look complete.\n\n${detail}`,
    0,
    0,
  )));
}
