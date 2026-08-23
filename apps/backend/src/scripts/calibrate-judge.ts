/**
 * Runs the judge against stored experiment runs, where ground truth exists.
 *
 *   npx tsx apps/backend/src/scripts/calibrate-judge.ts [experimentId]
 *
 * ── WHY THE EXPERIMENT CORPUS AND NOT LIVE LEAVES ──
 * Every experiment run carries a `verifyCommand` whose exit code decided `verified`, independently
 * of anything a model said. That is the only ground truth in this system that a judge cannot have
 * influenced. Live leaves, by contrast, are judged precisely BECAUSE nothing could check them —
 * there is nothing there to score against.
 *
 * The limitation that follows is real and is not hidden: this measures the judge on a different
 * distribution from the one it serves. What it can establish is that the judge is not systematically
 * fooled, is not answering from the task description, and agrees with itself. What it cannot
 * establish is accuracy on unverifiable work. See lib/judge-calibration.ts.
 *
 * ── THE CONTROL ──
 * Every run is scored twice more: once identically (stability) and once with the evidence replaced
 * by an unrelated diff (the null-input control). A judge that still approves the second one is not
 * reading its inputs — which is exactly what the abandoned harness-v2 judge did, and what nothing in
 * that system could have detected.
 */
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

/**
 * Evidence from a DIFFERENT task, for the control.
 *
 * Unrelated rather than empty, deliberately: an empty diff is a legible signal ("nothing was done")
 * that a careful judge should flag, whereas plausible work from elsewhere is the actual test — does
 * the verdict track the evidence, or the task description?
 */
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
    const resolved = resolveConfig(profile, persona);
    const chosenModel = typeof resolved.overrides.model === 'string' ? resolved.overrides.model : undefined;
    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(ownerId, chosenModel);
    console.log(`Scoring with ${provider.name} (${provider.model ?? 'default'}).\n`);

    /** One scoring pass. Returns the verdict, never throws. */
    const score = async (title: string, body: string, diff: string): Promise<JudgeVerdict> => {
      const { bundle } = buildJudgeBundle({ title, body, evidence: { capturedAt: 'n/a', diff } });
      const requestBody = buildModelRequest({
        turn: 'conversation',
        ...(provider.kind ? { kind: provider.kind } : {}),
        messages: [
          ...(resolved.systemPrompt ? [{ role: 'system', content: resolved.systemPrompt }] : []),
          { role: 'user', content: buildJudgePrompt(bundle, CODE_DIMENSIONS) },
        ],
        stream: true,
        // Same ceiling as the activity, and for the same reason — see JudgeLeafActivity. A
        // calibration run that starved the judge would measure the starvation, not the judge.
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
      // `runs` is the execution history: re-running an experiment APPENDS rather than resetting.
      for (const execution of experiment.runs ?? []) {
        // `attempted` drops infrastructure failures, which are not the judge's to get right —
        // counting them would put a harness outage into the judge's score.
        for (const result of attempted(execution.results ?? [])) {
          const diff = (result as any).evidence?.diff;
          if (!diff) continue;

          const task = (experiment.tasks ?? []).find((t: any) => t.id === (result as any).taskId);
          // Deliberately NOT `task.solution`: it exists to gate the verify command, and showing it
          // would make the judge's job a different and much easier one than the live case.
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
