export const ACTIVITY_CEILING = '30 days';
export const ACTIVITY_LIVENESS = '1 minute';

export const LIVE_ACTIVITY = { startToCloseTimeout: ACTIVITY_CEILING, heartbeatTimeout: ACTIVITY_LIVENESS } as const;

export const CLI_CEILING = '720h';
