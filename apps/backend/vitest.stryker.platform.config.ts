import { mutationTestsOf } from './vitest.stryker.shared.js';

export default mutationTestsOf('platform', [
  'src/platform/lib/change-streams.test.ts',
  'src/platform/lib/change-streams.integration.test.ts',
  'src/platform/middleware/auth.integration.test.ts',
]);
