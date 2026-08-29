
export const ACTIVITY_ATTEMPTS = 3;

export const DESTROY_ATTEMPTS = 5;

export const ACTIVITY_RETRY = {
  maximumAttempts: ACTIVITY_ATTEMPTS,
  initialInterval: '2s',
  backoffCoefficient: 2,
  maximumInterval: '30s',
} as const;

export const DESTROY_RETRY = {
  maximumAttempts: DESTROY_ATTEMPTS,
  initialInterval: '2s',
  backoffCoefficient: 2,
  maximumInterval: '30s',
} as const;
