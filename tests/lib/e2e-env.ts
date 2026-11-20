import { MECHANICS_CHECKS } from '../../apps/backend/src/eval/level2/mechanics.js';

export const NOT_ON_AN_INSTANCE: Readonly<Record<string, string>> = {
  'mechanics-member-asks': 'shares its project with the hub, and dev\'s hub has not reached the instance\'s Gitea since Gitea moved into the instance chart; the hub is frozen (owner, 2026-11-09: "if its slow and isn\'t telling us anything then either way")',
  'mechanics-run-revoked': 'signs its space out everywhere, which since step 3 only root does, and a check\'s space has no account at root; revocation reaches an instance only as root\'s signed back-channel logout',
};

export const shipChecks = (): string[] => MECHANICS_CHECKS().map((scenario) => scenario.id).filter((id) => !(id in NOT_ON_AN_INSTANCE));

export function e2eEnv(): Record<string, string> {
  return {
    CHECKS_LIVE_SCENARIOS: shipChecks().join(','),
    CHECKS_LIVE_TOGETHER: '3',
  };
}
