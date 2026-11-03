import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { giteaStandIn, type GiteaStandIn } from '../projects/testing/gitea-api.js';
import { createReleaseBrowserTestActivities } from './ReleaseBrowserTestsActivity.js';

const COMMIT = 'e'.repeat(40);
let gitea: GiteaStandIn;

beforeAll(async () => {
  gitea = await giteaStandIn({ owner: 'bo', name: 'shop', commit: COMMIT, files: {
    'e2e/sale.spec.ts': "test('sells', async () => {});\n",
    'e2e/odoo.ts': 'export {};\n',
    'addons/shop/__manifest__.py': '{}\n',
  } });
});
afterAll(async () => { await gitea.close(); });

describe('reading a build\'s browser tests through Gitea', () => {
  it('takes the specs and their helpers under e2e/ at the build\'s commit, with the config they run under, and says when there are none', async () => {
    const browser = createReleaseBrowserTestActivities({ cluster: () => { throw new Error('reading specs needs no cluster'); }, specs: async () => gitea.gitea() });
    const read = await browser.readSpecs({ owner: 'bo', repo: 'shop', commit: COMMIT });
    expect('files' in read && read.files.map((file) => file.path)).toEqual(['playwright.config.ts', 'e2e/odoo.ts', 'e2e/sale.spec.ts']);
    expect(await browser.readSpecs({ owner: 'bo', repo: 'shop', commit: 'f'.repeat(40) })).toEqual({ reason: `there are no browser tests in e2e/ at ${'f'.repeat(8)}` });
  });
});
