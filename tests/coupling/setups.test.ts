import { describe, expect, it } from 'vitest';
import type { Ran } from './collect.js';
import { importedFrom, injectionsIn, providedIn, setupsFor, type SetupWorld } from './setups.js';

const files: Record<string, string> = {
  'apps/backend/src/x/k3s.integration.test.ts': "import { helper } from '../testing/helper.js';\nconst k3s = inject('k3s');\n",
  'apps/backend/src/x/plain.integration.test.ts': "import { stores } from '../testing/stores.js';\n",
  'apps/backend/src/x/new.integration.test.ts': "import { files } from '../testing/files.js';\n",
  'apps/backend/src/testing/helper.ts': 'export const helper = 1;\n',
  'apps/backend/src/testing/stores.ts': "export const stores = 1;\nexport function bucket() {\n  return inject('minio');\n}\n",
  'apps/backend/src/testing/files.ts': "export { bucket } from './stores.js';\n",
};
const world: SetupWorld = {
  read: (file) => files[file],
  exists: (file) => file in files,
  providers: new Map([['k3s', 'k3s'], ['k3sClusterWide', 'k3s'], ['minio', 'minio']]),
};
const ran = (testFile: string, count: number): Ran => ({ testFile, files: { 'apps/backend/src/testing/stores.ts': [{ start: { line: 1, column: 1 }, end: { line: 1, column: 1 }, count: 1, fn: '' }, { start: { line: 2, column: 1 }, end: { line: 4, column: 2 }, count, fn: 'bucket' }] } });

describe('which optional setups a test needs', () => {
  it('reads what a setup provides and where a value is injected', () => {
    expect(providedIn("project.provide('k3s', a);\n  project.provide('k3sClusterWide', b);")).toEqual(['k3s', 'k3sClusterWide']);
    expect(injectionsIn("a\nconst m = inject('minio');")).toEqual([{ key: 'minio', line: 2 }]);
    expect(importedFrom('apps/backend/src/testing/files.ts', files['apps/backend/src/testing/files.ts']!, world.exists)).toEqual(['apps/backend/src/testing/stores.ts']);
  });

  it('starts a setup a test injects itself, or whose helper it ran', () => {
    expect(setupsFor(['apps/backend/src/x/k3s.integration.test.ts'], [ran('apps/backend/src/x/k3s.integration.test.ts', 0)], new Set(), world)).toEqual(['k3s']);
    expect(setupsFor(['apps/backend/src/x/plain.integration.test.ts'], [ran('apps/backend/src/x/plain.integration.test.ts', 3)], new Set(), world)).toEqual(['minio']);
  });

  it('starts nothing for a helper the test loaded and never called', () => {
    expect(setupsFor(['apps/backend/src/x/plain.integration.test.ts'], [ran('apps/backend/src/x/plain.integration.test.ts', 0)], new Set(), world)).toEqual([]);
  });

  it('follows the imports of a test with no record, or one that changed, to every value it could inject', () => {
    expect(setupsFor(['apps/backend/src/x/new.integration.test.ts'], [], new Set(), world)).toEqual(['minio']);
    expect(setupsFor(['apps/backend/src/x/plain.integration.test.ts'], [ran('apps/backend/src/x/plain.integration.test.ts', 0)], new Set(['apps/backend/src/x/plain.integration.test.ts']), world)).toEqual(['minio']);
  });
});
