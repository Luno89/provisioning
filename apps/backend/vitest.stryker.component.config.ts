import { defineConfig } from 'vitest/config';
import { tiers } from '../../tests/tiers/projects.js';

const [, integration] = tiers({ include: [], integration: { globalSetup: ['./vitest.global-setup.ts', './vitest.temporal-setup.ts'], setupFiles: ['./vitest.setup.ts'] } });

export default defineConfig({
  test: {
    ...integration!.test,
    name: 'component',
    globals: true,
    environment: 'node',
    include: [
      'src/accounts/services/AuthService.integration.test.ts',
      'src/accounts/services/ProjectInviteLimitsService.integration.test.ts',
      'src/accounts/routes/auth.integration.test.ts',
      'src/accounts/routes/admin.integration.test.ts',
      'src/engine/services/ApprovalService.integration.test.ts',
      'src/engine/services/RunGrantService.integration.test.ts',
      'src/engine/services/ConversationTurnService.integration.test.ts',
      'src/engine/services/ConversationNoticeService.integration.test.ts',
      'src/engine/services/TurnLogWriter.integration.test.ts',
      'src/engine/services/AgentChangeService.integration.test.ts',
    ],
  },
});
