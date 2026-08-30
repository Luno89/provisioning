import { createDatabase } from '../lib/db-interface.js';
import type { Leaf } from '../lib/leaves.js';
import { createModelService } from '../lib/model-wiring.js';
import { readStreamedReply } from '../lib/agent-loop.js';
import { buildModelRequest } from '../lib/model-request.js';
import { fittedMaxTokens } from '../lib/sampling.js';
import { resolveConfig } from '../lib/personas.js';
import { flattenPersona } from '../lib/persona-scope.js';
import { JUDGE_PERSONA } from '../lib/well-known-personas.js';
import { buildFailureNotice, withNotice } from '../lib/branch-notice.js';
import type { Branch } from '../lib/leaves.js';
import { withBuiltIns } from '../lib/ownership.js';
import { requireBudget } from '../lib/pack-defaults.js';
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

const JUDGE_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Judge exceeded ${ms / 1000}s`)), ms)),
  ]);
}

export async function JudgeLeafActivity(args: JudgeLeafArgs): Promise<JudgeLeafResult> {
  const db = createDatabase();
  await db.init();

  try {
    const leaf = (await db.getLeaves()).find((l: Leaf) => l.id === args.leafId);
    if (!leaf) return { leafId: args.leafId, verdict: 'unavailable' };

    if (!shouldJudge(leaf)) return { leafId: args.leafId, verdict: 'unavailable' };

    const trace = await db.getLeafTrace(leaf.id);
    const evidence = trace?.evidence;
    if (!evidence || (!evidence.diff && !evidence.findings && !evidence.expects?.length)) {
      await record(db, leaf, { verdict: 'unavailable', at: new Date().toISOString(), reason: 'no evidence was captured' });
      return { leafId: args.leafId, verdict: 'unavailable' };
    }

    const ownPersonas = withBuiltIns(await db.getPersonas(), leaf.ownerId, (p) => p.name);
    const packs = withBuiltIns(await db.getPersonaPacks(), leaf.ownerId, (p) => p.slug);
    const pack = packs.find((p: any) => p.name === JUDGE_PERSONA) ?? null;
    const assigned = pack ? ownPersonas.find((p: any) => p.id === pack.personaId) : undefined;
    const persona = assigned ? flattenPersona(assigned, ownPersonas) : null;
    if (!pack) console.warn(`[JudgeLeaf] no "${JUDGE_PERSONA}" pack — running with harness defaults`);

    const profile = await db.getHarnessProfile(leaf.ownerId).catch(() => null);
    const resolved = resolveConfig(profile, pack, {}, persona);
    const chosen = typeof resolved.overrides.model === 'string' ? resolved.overrides.model : undefined;

    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(leaf.ownerId, chosen, pack?.model?.endpointId);

    const dimensions = evidence.findings && !evidence.diff ? RESEARCH_DIMENSIONS : CODE_DIMENSIONS;
    const { bundle, dropped } = buildJudgeBundle({
      title: leaf.title,
      ...(leaf.body ? { body: leaf.body } : {}),
      ...(leaf.expects?.length ? { expects: leaf.expects } : {}),
      evidence,
    });
    if (dropped.length) console.log(`[JudgeLeaf] ${leaf.id}: bundle dropped ${dropped.join(', ')}`);

    const budget = pack?.budget ?? await requireBudget(db);
    const body = buildModelRequest({
      turn: 'conversation',
      ...(pack?.sampling ? { sampling: pack.sampling } : {}),
      ...(provider.kind ? { kind: provider.kind } : {}),
      messages: [
        ...(resolved.systemPrompt ? [{ role: 'system', content: resolved.systemPrompt }] : []),
        { role: 'user', content: buildJudgePrompt(bundle, dimensions) },
      ],
      stream: true,
      maxTokens: fittedMaxTokens(budget, budget.replyTokens.thinking * 3, bundle.length, provider.contextTokens),
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

    const answer = (reply.content ?? '').trim() || (reply.reasoning ?? '').trim();
    const { dimensions: kept, fabricated } = parseJudgeReply(answer, bundle);

    if (!kept.length) {
      console.warn(
        `[JudgeLeaf] ${leaf.id}: no usable findings (${fabricated} fabricated). `
        + `Reply began: ${answer.slice(0, 300).replace(/\s+/g, ' ') || '(empty)'}`,
      );
    }
    if (fabricated) {
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

async function record(db: any, leaf: Leaf, review: NonNullable<Leaf['review']>): Promise<void> {
  const fresh = (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);
  if (!fresh) return;
  await db.saveLeaf({ ...fresh, review, updatedAt: new Date().toISOString() });
}

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
