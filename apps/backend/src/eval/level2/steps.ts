import type { Scenario } from './scenario.js';
import { stepProcedureId } from '../../lib/step-check.js';
import { ODOO_E2E_EXAMPLE, ODOO_PLAYWRIGHT_CONFIG } from '../../lib/project-templates.js';
import { MISSING_FIELD_SPEC, PROBE_FILES } from './mechanics.js';

const step = (scenario: Omit<Scenario, 'procedure'>): Scenario => ({ ...scenario, procedure: { id: stepProcedureId(scenario.id) } });

const ODOO_EXECUTOR = { executor: { environment: { terminal: true, filesystem: true, workspace: true, languages: ['odoo'] } } };
const ODOO_E2E_FILES = { ...PROBE_FILES, 'playwright.config.ts': ODOO_PLAYWRIGHT_CONFIG, 'e2e/signs-in.spec.ts': ODOO_E2E_EXAMPLE };

export const STEP_CHECKS = (): Scenario[] => [
  step({
    id: 'step-write-file-says-what-it-wrote',
    name: 'write_file tells the model what it wrote',
    describe: 'Step, no model: one Call Tool node runs write_file in a sandbox; the text the model would get back says what was written and where.',
    agent: 'executor',
    step: { node: 'call-tool', settings: { tool: 'write_file', args: '{"path":"step.md","content":"hello"}' } },
    input: { message: 'Write the file.' },
    expect: { exit: 'ok', outputs: { text: { equals: 'wrote 5 bytes to step.md' } } },
  }),
  step({
    id: 'step-write-file-writes-json-content',
    name: 'write_file writes JSON content out as JSON',
    describe: 'Step, no model: write_file is given its content as JSON data rather than text, as models do for .json files; it writes that JSON, never an empty file.',
    agent: 'executor',
    step: { node: 'call-tool', settings: { tool: 'write_file', args: '{"path":"plan.json","content":[{"title":"a","leaves":[]}]}' } },
    input: { message: 'Write the file.' },
    expect: { exit: 'ok', outputs: { text: { equals: 'wrote 47 bytes to plan.json — content arrived as JSON data, so it was written out as JSON' } } },
  }),
  step({
    id: 'step-decide-reads-yes',
    name: 'Decide follows a plain yes',
    describe: 'Step, on a script: one Decide node asks the model its question and leaves by yes when the answer is yes.',
    agent: 'koala',
    step: { node: 'decide', settings: { question: 'Does this say the work is done?' }, inputs: { text: 'The work is done.' } },
    script: { rules: [{ when: { asked: '^Question: ' }, reply: { say: 'yes' } }, { when: {}, reply: { say: 'Nothing to do here.' } }] },
    input: { message: 'Decide.' },
    expect: { exit: 'yes' },
  }),
  step({
    id: 'step-run-e2e-passes-in-odoo',
    name: 'Run Browser Tests passes against the Odoo its workspace serves',
    describe: 'Step, no model: one Run Browser Tests node runs in an Odoo workspace holding a module and a sign-in spec; koala-e2e serves a throwaway Odoo with the module, Chromium signs in, and the node leaves by passed with each test in its report.',
    agent: 'executor',
    world: { agents: ODOO_EXECUTOR, files: ODOO_E2E_FILES },
    step: { node: 'host-op', settings: { operation: 'platform.run-e2e', specs: ['e2e'] } },
    input: { message: 'Run the browser tests.' },
    expect: { exit: 'passed', outputs: { summary: { equals: '1 passed, 0 failed' }, report: { contains: '"title":"a person signs in and reaches the Odoo home","file":"signs-in.spec.ts","status":"passed"' } } },
  }),
  step({
    id: 'step-run-e2e-fails-and-keeps-what-it-saw',
    name: 'Run Browser Tests fails a test and keeps what the browser saw',
    describe: 'Step, no model: one Run Browser Tests node runs in an Odoo workspace whose spec looks for a field nobody made; it leaves by failed naming that test, and keeps the screenshot, trace and video as artifacts it links.',
    agent: 'executor',
    world: { agents: ODOO_EXECUTOR, files: { ...ODOO_E2E_FILES, 'e2e/missing-field.spec.ts': MISSING_FIELD_SPEC } },
    step: { node: 'host-op', settings: { operation: 'platform.run-e2e', specs: ['e2e'] } },
    input: { message: 'Run the browser tests.' },
    expect: { exit: 'failed', outputs: {
      summary: { contains: 'FAILED — a person sees the never-made field on the home page (missing-field.spec.ts)' },
      artifacts: { contains: '/api/artifacts/' },
    } },
  }),
];
