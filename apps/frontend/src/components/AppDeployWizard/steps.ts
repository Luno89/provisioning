import { defaultsFor } from '../app-catalog';

export const FIRST_STEP = 1;
export const LAST_STEP = 6;

export const isModelApp = (appType: string): boolean =>
  appType === 'vllm' || appType === 'tabbyapi';

export const hasDatabase = (appType: string): boolean =>
  Boolean(defaultsFor(appType).hasDatabase);

/**
 * A catalogue app (built-in or a user's own custom spec) deploys entirely from its stored AppSpec
 * — image, ports, env, volumes are never read from the wizard, so steps 2-5 (strategy, model
 * search, image/tag, database) would show fields that are silently ignored if submitted. Skip
 * straight to the confirm step.
 */
export function nextStep(step: number, appType: string, isCatalogueApp = false): number {
  if (isCatalogueApp) return step === 1 ? LAST_STEP : Math.min(step + 1, LAST_STEP);
  if (step === 2) return isModelApp(appType) ? 3 : 4;
  if (step === 3) return 4;
  if (step === 4 && !hasDatabase(appType)) return 6;
  return Math.min(step + 1, LAST_STEP);
}

export function prevStep(step: number, appType: string, isCatalogueApp = false): number {
  if (isCatalogueApp) return step === LAST_STEP ? 1 : Math.max(step - 1, FIRST_STEP);
  if (step === 4) return isModelApp(appType) ? 3 : 2;
  if (step === 3) return 2;
  if (step === 6 && !hasDatabase(appType)) return 4;
  return Math.max(step - 1, FIRST_STEP);
}
