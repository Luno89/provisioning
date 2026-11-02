import { MECHANICS_CHECKS } from '../../apps/backend/src/eval/level2/mechanics.js';

export function e2eEnv(admin: string): Record<string, string> {
  return {
    GROVE_LIVE_OWNER: admin,
    CHECKS_LIVE_OWNER: admin,
    INSTANCE_LIVE_OWNER: admin,
    CHECKS_LIVE_SCENARIOS: MECHANICS_CHECKS().map((scenario) => scenario.id).join(','),
    CHECKS_LIVE_ALL_PASS: 'true',
    CHECKS_LIVE_TOGETHER: '3',
  };
}
