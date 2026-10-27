// ── DUPLICATED, KNOWINGLY ──
// apps/backend/src/infrastructure/lib/app-sign-in.ts (SIGN_IN_APPS) wins: these are the apps whose sign-in Koala makes
// and the app's page offers to show.
export const SIGN_IN_APPS = ['hermes', 'nextcloud', 'minio', 'palworld'] as const

export const signsIn = (appType: string | undefined): boolean => (SIGN_IN_APPS as readonly string[]).includes(appType ?? '')
