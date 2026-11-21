import { mutationTestsOf } from './vitest.stryker.shared.js';

export default mutationTestsOf('component', [
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
]);
