import type { HostOperation } from '@koala/agent-engine/procedure';
import { E2E_DEFAULT_SPECS, E2E_TIMEOUT_MS } from '../../../lib/e2e.js';

export const PLATFORM_OPERATIONS: readonly HostOperation[] = [
  {
    name: 'platform.run-e2e',
    title: 'Run Browser Tests',
    group: 'Testing',
    describe: 'Runs Playwright browser tests in the workspace, against the app the workspace serves (its image\'s koala-e2e: an Odoo workspace starts a throwaway Odoo with every module under addons/) or against an address that needs no login. Reports each test, and keeps the screenshots, traces and videos of failures.',
    inputs: [{ name: 'environment', type: 'environment', describe: 'Where to run them. Nothing wired means the run\'s own workspace.' }],
    outputs: [
      { name: 'report', type: 'json', describe: 'How many passed, failed, were flaky or skipped, and each test with its file, status, time and error.' },
      { name: 'summary', type: 'text', describe: 'The result in words: the counts, each failed test and why, and links to what the browser left behind.' },
      { name: 'artifacts', type: 'json', describe: 'The kept failure screenshots, traces and videos, each with its id, name and address.' },
      { name: 'reason', type: 'text', describe: 'Why the tests could not be run, when they could not.' },
    ],
    exits: [
      { name: 'passed', describe: 'Every test passed.' },
      { name: 'failed', describe: 'A test failed, or the app did not come up for them.' },
      { name: 'unavailable', describe: 'There is nowhere to run them, or the workspace has no browser runner.' },
    ],
    settings: {
      type: 'object',
      properties: {
        specs: { type: 'array', title: 'Specs', describe: 'Playwright spec files or folders, relative to the workspace.', items: { type: 'string', minLength: 1 }, default: E2E_DEFAULT_SPECS, minItems: 1 },
        url: { type: 'string', title: 'Address', describe: 'Leave empty to test the app the workspace serves. Otherwise an http or https address that needs no login, since the workspace\'s agent can read anything given to it.' },
        minutes: { type: 'integer', title: 'Time limit (minutes)', minimum: 1, maximum: 120, default: E2E_TIMEOUT_MS / 60_000 },
      },
    },
    summary: 'runs browser tests',
    idempotent: true,
  },
];
