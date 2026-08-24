import { defaultsFor } from '../app-catalog';

/**
 * Which step comes next, and which came before.
 *
 * ── WHY THIS IS A PURE FUNCTION AND NOT TWO HANDLERS ──
 * It was `nextStep`/`prevStep` inside `App.tsx`, closing over `wizardStep` and `wizardData`. Both
 * carry real branching — two steps are conditionally skipped — and neither could be tested without
 * mounting a 2,800-line component and clicking through six screens.
 *
 * Six steps: 1 cluster, 2 app type, 3 model (model apps only), 4 image, 5 database (only for apps
 * that have one), 6 review. The skips are what make this worth extracting: a wizard that shows a
 * database step for Palworld, or a model step for WordPress, is asking for values it will discard.
 */

export const FIRST_STEP = 1;
export const LAST_STEP = 6;

/** vLLM and TabbyAPI are the two that serve a model, so they get the model-picker step. */
export const isModelApp = (appType: string): boolean =>
  appType === 'vllm' || appType === 'tabbyapi';

/** Whether this app type deploys a database alongside it, and therefore needs step 5. */
export const hasDatabase = (appType: string): boolean =>
  Boolean(defaultsFor(appType).hasDatabase);

export function nextStep(step: number, appType: string): number {
  if (step === 2) return isModelApp(appType) ? 3 : 4;
  if (step === 3) return 4;
  // Step 5 is the database step. Skipping it lands on review.
  if (step === 4 && !hasDatabase(appType)) return 6;
  return Math.min(step + 1, LAST_STEP);
}

export function prevStep(step: number, appType: string): number {
  if (step === 4) return isModelApp(appType) ? 3 : 2;
  if (step === 3) return 2;
  if (step === 6 && !hasDatabase(appType)) return 4;
  return Math.max(step - 1, FIRST_STEP);
}
