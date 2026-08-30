import { createDatabase } from '../lib/db-interface.js';
import { createModelService } from '../lib/model-wiring.js';
import { readStreamedReply } from '../lib/agent-loop.js';
import { buildModelRequest } from '../lib/model-request.js';
import { fittedMaxTokens, THINKING_TURN_MAX_TOKENS } from '../lib/sampling.js';
import { resolveConfig } from '../lib/personas.js';
import { flattenPersona } from '../lib/persona-scope.js';
import { JUDGE_PERSONA } from '../lib/well-known-personas.js';
import { attempted } from '../lib/run-outcome.js';
import {
  buildJudgeBundle, buildJudgePrompt, parseJudgeReply, combineJudgement,
  CODE_DIMENSIONS, type JudgeVerdict,
} from '../lib/leaf-judge.js';
import { calibrate, formatCalibration, type CalibrationRow } from '../lib/judge-calibration.js';
import { defaultSampling } from '../lib/pack-sampling.js';

const DECOY_DIFF = [
  'diff --git a/src/colours.ts b/src/colours.ts',
  '--- a/src/colours.ts',
  '+++ b/src/colours.ts',
  '@@ -1,3 +1,7 @@',
  '+export const PALETTE = ["#1d212c", "#2a2e3d"];',
  '+export function shade(hex: string, amount: number): string {',
  '+  return hex;',
  '+}',
].join('\n');

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const sampling = await defaultSampling(db);

  try {
    const wanted = process.argv[2];
    const experiments = await db.getExperiments();
    const chosen = wanted ? experiments.filter((e: any) => e.id === wanted) : experiments;
    if (!chosen.length) {
      console.error(wanted ? `No experiment ${wanted}` : 'No experiments stored — nothing to calibrate against.');
      process.exitCode = 1;
      return;
    }

    const ownerId = chosen[0]?.ownerId;
    if (!ownerId) {
      console.error('The chosen experiment has no owner — cannot resolve a model to score with.');
      process.exitCode = 1;
      return;
    }
    const ownPersonas = (await db.getPersonas()).filter((p: any) => p.ownerId === ownerId);
    const assigned = ownPersonas.find((p: any) => p.name === JUDGE_PERSONA);
    const persona = assigned ? flattenPersona(assigned, ownPersonas) : null;
    if (!assigned) console.warn(`No "${JUDGE_PERSONA}" persona — scoring with harness defaults.`);

    const profile = await db.getHarnessProfile(ownerId).catch(() => null);
    const resolved = resolveConfig(profile, null, {}, persona);
    const chosenModel = typeof resolved.overrides.model === 'string' ? resolved.overrides.model : undefined;
    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(ownerId, chosenModel);
    console.log(`Scoring with ${provider.name} (${provider.model ?? 'default'}).\n`);

    const score = async (title: string, body: string, diff: string): Promise<JudgeVerdict> => {
      const { bundle } = buildJudgeBundle({ title, body, evidence: { capturedAt: 'n/a', diff } });
      const requestBody = buildModelRequest({
        turn: 'conversation',
        ...(sampling ? { sampling } : {}),
        ...(provider.kind ? { kind: provider.kind } : {}),
        messages: [
          ...(resolved.systemPrompt ? [{ role: 'system', content: resolved.systemPrompt }] : []),
          { role: 'user', content: buildJudgePrompt(bundle, CODE_DIMENSIONS) },
        ],
        stream: true,
        maxTokens: fittedMaxTokens(THINKING_TURN_MAX_TOKENS * 2, bundle.length),
        ...(provider.model ? { model: provider.model } : {}),
        overrides: resolved.overrides,
      }).body;

      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(requestBody),
        });
        if (!res.ok) return 'unavailable';
        const reply = await readStreamedReply(res as any);
        return combineJudgement(parseJudgeReply(reply.content ?? '', bundle).dimensions);
      } catch {
        return 'unavailable';
      }
    };

    const rows: CalibrationRow[] = [];

    for (const experiment of chosen) {
      for (const execution of experiment.runs ?? []) {
        for (const result of attempted(execution.results ?? [])) {
          const diff = (result as any).evidence?.diff;
          if (!diff) continue;

          const task = (experiment.tasks ?? []).find((t: any) => t.id === (result as any).taskId);
          const title = task?.name ?? (result as any).taskId ?? 'task';
          const body = task?.prompt ?? '';

          process.stdout.write('.');
          const verdict = await score(title, body, diff);
          const repeat = await score(title, body, diff);
          const nullInput = await score(title, body, DECOY_DIFF);

          rows.push({
            id: `${experiment.id}:${(result as any).taskId}:${rows.length}`,
            verified: Boolean((result as any).verified),
            verdict, repeat, nullInput,
          });
        }
      }
    }

    console.log('\n');
    if (!rows.length) {
      console.error(
        'No stored run carried captured evidence. Evidence capture is recent — run an experiment\n'
        + 'first, then calibrate against it.',
      );
      process.exitCode = 1;
      return;
    }

    console.log(formatCalibration(calibrate(rows)));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`calibrate-judge failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
