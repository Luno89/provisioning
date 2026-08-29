import { defaultsFor } from '../app-catalog';

export const FIRST_STEP = 1;
export const LAST_STEP = 6;

export const isModelApp = (appType: string): boolean =>
  appType === 'vllm' || appType === 'tabbyapi';

export const hasDatabase = (appType: string): boolean =>
  Boolean(defaultsFor(appType).hasDatabase);

export function nextStep(step: number, appType: string): number {
  if (step === 2) return isModelApp(appType) ? 3 : 4;
  if (step === 3) return 4;
  if (step === 4 && !hasDatabase(appType)) return 6;
  return Math.min(step + 1, LAST_STEP);
}

export function prevStep(step: number, appType: string): number {
  if (step === 4) return isModelApp(appType) ? 3 : 2;
  if (step === 3) return 2;
  if (step === 6 && !hasDatabase(appType)) return 4;
  return Math.max(step - 1, FIRST_STEP);
}
