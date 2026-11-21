import base, { frontendTiers } from './vitest.config';

export default { ...base, test: { ...base.test, projects: frontendTiers(['src/features/platform/stores/socket*.test.ts']) } };
