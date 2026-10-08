import { MODEL_TURN, type Procedure } from '@koala/agent-engine/procedure';
import type { Scenario } from './scenario.js';
import type { CheckScript } from '../../lib/check-script.js';
import { seededProcedures } from '../../extensions/seeds.js';
import { CATCH_ALL_TREE_TYPE, ODOO_TREE_TYPE } from '../../lib/tree-type-seeds.js';

const NOTHING = { when: {}, reply: { say: 'Nothing to do here.' } };
const DECIDE = { when: { asked: '^Question: ' }, reply: { say: 'yes' } };
const QUESTIONS = ['the year the first version of Node.js was released', 'the default TCP port PostgreSQL listens on', 'who created the Python programming language'];

const judged: Scenario = {
  id: 'mechanics-judge-verdict',
  name: 'A verdict reaches the conversation',
  describe: 'Mechanics, on a script: the judge runs a command and records its verdict with record_verdict, and verdict.md is written in its directory.',
  agent: 'judge',
  procedure: { id: 'tool-rounds' },
  input: { message: 'Judge this. Work: `expr 6 \\* 7` prints 42. Expected: it prints 42.', inputs: { work: '`expr 6 \\* 7` prints 42', expected: 'it prints 42' } },
  script: { rules: [
    { when: { offered: ['record_verdict'], notCalled: ['run_command'] }, reply: { call: [{ tool: 'run_command', arguments: { command: 'expr 6 \\* 7' } }] } },
    { when: { offered: ['record_verdict'], called: ['run_command'], notCalled: ['record_verdict'] }, reply: { call: [{ tool: 'record_verdict', arguments: { verdict: 'met', reasoning: 'expr printed {{result.run_command}}' } }] } },
    { when: { offered: ['record_verdict'] }, reply: { say: 'Met: the command printed 42.' } },
    NOTHING,
  ] },
  expect: {
    outcome: 'ok',
    toolsInOrder: ['run_command', 'record_verdict'],
    toolsSucceeded: ['record_verdict'],
    files: [{ path: 'verdict.md', contains: ['Verdict: met'] }],
  },
};

const researched: Scenario = {
  id: 'mechanics-research-workspace',
  name: 'Research shares one workspace that outlives its pod',
  describe: 'Mechanics, on a script: three research hand-offs run at once in the conversation\'s workspace, each in its own directory; Koala reads what they wrote; after the quiet time the workspace is saved and gone; a later turn finds the files again.',
  agent: 'koala',
  procedure: { id: 'interactive-chat' },
  input: { message: 'Look three things up at once and summarise them.' },
  world: { agents: { koala: { concludeAfterMinutes: 1 } } },
  script: { rules: [
    { when: { offered: ['research'], asked: 'Look three things up', notCalled: ['research'] }, reply: { call: QUESTIONS.map((question) => ({ tool: 'research', arguments: { question } })) } },
    { when: { offered: ['research'], asked: 'Look three things up', called: ['research'], notCalled: ['read_file'], said: '(research/run-[^\\s"\'`\\\\]+/findings\\.md)' }, reply: { call: [{ tool: 'read_file', arguments: { path: '{{said.1}}' } }] } },
    { when: { offered: ['research'], asked: 'Look three things up', called: ['read_file'], said: '(research/run-[^\\s"\'`\\\\]+/findings\\.md)' }, reply: { say: 'All three are answered; the first is in {{said.1}}.' } },
    { when: { offered: ['research'], asked: 'again', notCalled: ['read_file'], said: '(research/run-[^\\s"\'`\\\\]+/findings\\.md)' }, reply: { call: [{ tool: 'read_file', arguments: { path: '{{said.1}}' } }] } },
    { when: { offered: ['research'], asked: 'again', called: ['read_file'] }, reply: { say: 'The first line is the findings heading.' } },
    { when: { offered: ['write_file'], notCalled: ['write_file'], said: '(the year the first version of Node\\.js was released|the default TCP port PostgreSQL listens on|who created the Python programming language)' }, reply: { call: [{ tool: 'write_file', arguments: { path: '{{directory}}findings.md', content: '# Findings\n\nThe question was {{said.1}}.\n' } }] } },
    { when: { offered: ['write_file'], called: ['write_file'] }, reply: { say: 'The answer is in {{directory}}findings.md.' } },
    NOTHING,
  ] },
  expect: {
    outcome: 'ok',
    handOffs: [{ agent: 'research', atLeast: 3, together: true }],
    modelSaw: { contains: ['The question was'] },
  },
  then: [
    { name: 'after the quiet time', do: { waitQuiet: true }, expect: { workspace: { of: 'conversation', exists: false } } },
    { name: 'a later turn', do: { chat: { message: 'Read that findings file again and quote its first line.' } }, expect: { outcome: 'ok', toolsSucceeded: ['read_file'], modelSaw: { contains: ['# Findings'] } } },
  ],
};

const COMPACTION_PROCEDURE = (): Procedure => {
  const chat = seededProcedures().find((procedure) => procedure.id === 'interactive-chat')!;
  const turn = structuredClone(MODEL_TURN) as unknown as { nodes: { id: string; settings: Record<string, unknown> }[] };
  const compact = turn.nodes.find((node) => node.id === 'compact');
  if (compact) compact.settings = { ...compact.settings, at: 0.5 };
  return { ...chat, id: 'mechanics-compaction-chat', name: 'Compaction check chat', groups: [...((chat as { groups?: unknown[] }).groups ?? []), turn] } as Procedure;
};

const LONG_REPLY = Array.from({ length: 1000 }, (_, index) => `word${index}`).join(' ');
const TOPICS = ['lighthouses', 'glaciers', 'honeybees', 'sourdough', 'suspension bridges', 'arctic terns', 'tides'];

const compacted = (): Scenario => ({
  id: 'mechanics-compaction',
  name: 'A long conversation is summarised and the summary is used',
  describe: 'Mechanics, on a script: a chat set to summarise at half its window grows past it; the conversation keeps the summary, and later turns are sent the summary instead of what it replaced — a code word from before it still reaches the model.',
  agent: 'koala',
  procedure: { id: 'mechanics-compaction-chat' },
  input: { message: 'Remember this code word for later in our conversation: PELICAN-42. Just confirm you have it.' },
  world: { procedures: [COMPACTION_PROCEDURE()], agents: { koala: { procedure: 'mechanics-compaction-chat' } } },
  script: { contextTokens: 32_000, rules: [
    { when: { system: '^You are summarising the earlier part', said: 'code word (?:for later in our conversation: )?([A-Z]+-\\d+)' }, reply: { say: 'Summary of the conversation so far: the person gave the code word {{said.1}}, then asked for long pieces on several topics.' } },
    { when: { system: '^You are summarising the earlier part' }, reply: { say: 'Summary of the conversation so far: long pieces on several topics.' } },
    { when: { asked: '^Remember this code word' }, reply: { say: 'I have the code word.' } },
    { when: { asked: '^What was the code word', said: 'code word (?:for later in our conversation: )?([A-Z]+-\\d+)' }, reply: { say: '{{said.1}}' } },
    { when: { asked: '^Write about' }, reply: { say: LONG_REPLY } },
    { when: {}, reply: { say: 'The lighthouses, for the light they keep.' } },
  ] } satisfies CheckScript,
  expect: { outcome: 'ok' },
  then: [
    ...TOPICS.map((topic) => ({ name: `a long reply on ${topic}`, do: { chat: { message: `Write about 900 words on ${topic}.` } } })),
    { name: 'the turn after the summary', do: { chat: { message: 'In two sentences, which topic was most interesting?' } }, expect: { outcome: 'ok', summaryKept: true, modelSaw: { contains: ['Summary of the conversation so far'], lacks: ['Remember this code word'] } } },
    { name: 'recalling the code word', do: { chat: { message: 'What was the code word I gave you at the very start?' } }, expect: { outcome: 'ok', modelSaw: { contains: ['PELICAN-42'] } } },
  ],
});

const NINETY = Array.from({ length: 90 }, (_, index) => `word${index + 1}`).join(' ');
const COUNT = Array.from({ length: 200 }, (_, index) => String(index + 1)).join('\n');

const logged: Scenario = {
  id: 'mechanics-turn-log',
  name: 'Every turn is in the turn log, even one that dies',
  describe: 'Mechanics, on a script: a slow turn is logged with no gap and saved as what the log streamed; a turn killed mid-reply is kept as what it had said, marked interrupted.',
  agent: 'koala',
  procedure: { id: 'interactive-chat' },
  input: { message: 'Tell me ninety words, one after another.' },
  script: { rules: [
    { when: { asked: 'Count slowly' }, reply: { say: COUNT, paceMs: 200 } },
    { when: { asked: 'ninety words' }, reply: { say: NINETY, paceMs: 100 } },
    NOTHING,
  ] },
  expect: { outcome: 'ok', turnLog: { complete: true }, interrupted: false },
  then: [
    { name: 'a turn that dies', do: { chat: { message: 'Count slowly from one to two hundred, one number per line.', killAfterChars: 40 } }, expect: { interrupted: true } },
  ],
};

const LEAVES = [
  { key: 'alpha', title: 'Alpha files', file: 'alpha.txt', line: 'alpha' },
  { key: 'beta', title: 'Beta files', file: 'beta.txt', line: 'beta' },
];
const write = (leaf: typeof LEAVES[number]) => `Write ${leaf.file} and add a line to shared.txt`;

const landed: Scenario = {
  id: 'mechanics-landing',
  name: 'Verified leaves land on main',
  describe: 'Mechanics, on a script: a plan is approved into a tree, worked and judged; one leaf merges, one conflicts and its merge task resolves it, one has nothing to land; every landing goes through a pull request.',
  agent: 'planner',
  procedure: { id: 'planning' },
  input: { message: 'Plan the landing check tree.', inputs: { goal: 'landing check' } },
  script: { rules: [
    { when: { offered: ['propose_plan'], notCalled: ['propose_plan'] }, reply: { call: [{ tool: 'propose_plan', arguments: {
      tree: { name: 'Landing check', type: CATCH_ALL_TREE_TYPE, goal: 'Leaves that each write files, landing on main.' },
      planDoc: '# Landing check\n\n## Destination\nalpha.txt, beta.txt and shared.txt on main.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything else.\n',
      branches: [{ title: 'Files', leaves: [
        ...LEAVES.map((leaf) => ({
          key: leaf.key, title: leaf.title, body: `${leaf.file} holds "${leaf.line}", and shared.txt has a line saying ${leaf.line}`, brief: `Write ${leaf.file} and shared.txt.`,
          tasks: [{ key: 'write', title: write(leaf), description: `Create ${leaf.file} and shared.txt saying ${leaf.line}.`, role: 'The leaf.', doneMeans: `${leaf.file} exists`, checks: { fileExists: leaf.file } }],
        })),
        { key: 'gamma', title: 'Plan already on main', body: 'PLAN.md is on main already', brief: 'Nothing to write.', tasks: [{ key: 'confirm', title: 'Confirm PLAN.md is on main', description: 'Check PLAN.md.', role: 'A leaf with nothing to land.', doneMeans: 'PLAN.md exists', checks: { fileExists: 'PLAN.md' } }] },
      ] }],
    } }] } },
    { when: { offered: ['propose_plan'] }, reply: { say: 'Proposed; it waits for your approval.' } },
    DECIDE,
    { when: { offered: ['settle_leaf'], notCalled: ['settle_leaf'] }, reply: { call: [{ tool: 'settle_leaf', arguments: { leafId: '{{mentioned.leaf}}', verdict: 'verified', note: 'scripted' } }] } },
    { when: { offered: ['settle_leaf'] }, reply: { say: 'Settled.' } },
    { when: { offered: ['record_verdict'], notCalled: ['record_verdict'] }, reply: { call: [{ tool: 'record_verdict', arguments: { verdict: 'met', reasoning: 'scripted' } }] } },
    { when: { offered: ['record_verdict'] }, reply: { say: 'Met.' } },
    ...LEAVES.map((leaf) => ({ when: { offered: ['write_file'], asked: `Work the task ${write(leaf)}`, notCalled: ['write_file'] }, reply: { call: [
      { tool: 'write_file', arguments: { path: leaf.file, content: `${leaf.line}\n` } },
      { tool: 'write_file', arguments: { path: 'shared.txt', content: `${leaf.line}\n` } },
    ] } })),
    { when: { offered: ['run_command'], asked: 'Work the task Merge main', notCalled: ['run_command'] }, reply: { call: [{ tool: 'run_command', arguments: { command: 'git merge main >/dev/null 2>&1; printf \'alpha\\nbeta\\n\' > shared.txt && git add -A && git commit --no-edit -q && git log --oneline -1' } }] } },
    { when: { offered: ['list_dir'], asked: 'Work the task Confirm PLAN', notCalled: ['list_dir'] }, reply: { call: [{ tool: 'list_dir', arguments: { path: '.' } }] } },
    { when: { asked: 'Work the task' }, reply: { say: 'Done.' } },
    NOTHING,
  ] },
  expect: { outcome: 'ok', toolsSucceeded: ['propose_plan'], files: [{ path: 'plan.md', contains: ['Landing check'] }] },
  then: [
    { name: 'approving the plan', do: { approvePlan: true }, expect: { repository: { of: 'tree', files: [{ path: 'PLAN.md', contains: ['## Destination'] }] } } },
    { name: 'the tree runs until quiet', do: { runTree: true }, expect: {
      outcome: 'ok',
      leaves: { verified: 3, landed: { 'Alpha files': 'merged', 'Beta files': 'merged', 'Plan already on main': 'nothing' }, mergeTasks: 1 },
      repository: { of: 'tree', files: [{ path: 'alpha.txt', contains: ['alpha'] }, { path: 'beta.txt', contains: ['beta'] }, { path: 'shared.txt', contains: ['alpha', 'beta'] }] },
      pullRequests: { merged: 2, open: 0, closedUnmerged: 1 },
    } },
    { name: 'deleting the tree', do: { deleteTree: true }, expect: { workspace: { of: 'tree', exists: false } } },
  ],
};

const deletedProject: Scenario = {
  id: 'mechanics-project-deletion',
  name: 'Deleting a project takes its tree with it',
  describe: 'Mechanics, on a script: a plan for the check\'s project is approved into the project\'s repository, then the project is deleted — the project, its tree and the tree\'s workspace are gone.',
  agent: 'planner',
  procedure: { id: 'planning' },
  input: { message: 'Plan the deletion check.', inputs: { goal: 'deletion check', projectId: '{{world.projectId}}' } },
  world: { project: { name: 'deletion-check' } },
  script: { rules: [
    { when: { offered: ['propose_plan'], notCalled: ['propose_plan'] }, reply: { call: [{ tool: 'propose_plan', arguments: {
      tree: { name: 'Deletion check', type: CATCH_ALL_TREE_TYPE, goal: 'A tree to delete with its project.' },
      planDoc: '# Deletion check\n\n## Destination\nNothing.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything.\n',
      branches: [{ title: 'Only', leaves: [{ key: 'one', title: 'One leaf', body: 'one.txt exists', brief: 'Write one.txt.', tasks: [{ key: 'w', title: 'Write one.txt', description: 'Write it.', role: 'All of it.', doneMeans: 'one.txt exists' }] }] }],
    } }] } },
    { when: { offered: ['propose_plan'] }, reply: { say: 'Proposed.' } },
    NOTHING,
  ] },
  expect: { outcome: 'ok', toolsSucceeded: ['propose_plan'] },
  then: [
    { name: 'approving the plan into the project', do: { approvePlan: true }, expect: { trees: 1, repository: { of: 'tree', files: [{ path: 'PLAN.md', contains: ['## Destination'] }] } } },
    { name: 'deleting the project', do: { deleteProject: true }, expect: { outcome: 'ok', project: { exists: false }, trees: 0, workspace: { of: 'tree', exists: false } } },
  ],
};

export const PROBE = 'koala_probe';
export const PROBE_FILES: Record<string, string> = {
  [`addons/${PROBE}/__init__.py`]: 'from . import models\n',
  [`addons/${PROBE}/__manifest__.py`]: "{\n    'name': 'Koala probe',\n    'version': '18.0.1.0.0',\n    'depends': ['base'],\n    'data': ['security/ir.model.access.csv'],\n    'license': 'LGPL-3',\n}\n",
  [`addons/${PROBE}/models/__init__.py`]: 'from . import probe\n',
  [`addons/${PROBE}/models/probe.py`]: "from odoo import fields, models\n\n\nclass Probe(models.Model):\n    _name = 'koala.probe'\n    _description = 'Koala probe'\n\n    name = fields.Char(required=True)\n    size = fields.Integer(default=1)\n",
  [`addons/${PROBE}/security/ir.model.access.csv`]: 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_koala_probe,koala.probe,model_koala_probe,base.group_user,1,1,1,1\n',
  [`addons/${PROBE}/tests/__init__.py`]: 'from . import test_probe\n',
  [`addons/${PROBE}/static/description/index.html`]: `<section>\n${'<p>Koala probe — a module Koala builds to check itself.</p>\n'.repeat(700)}<p>koala_probe ends here</p>\n</section>\n`,
  [`addons/${PROBE}/tests/test_probe.py`]: "from odoo.tests import TransactionCase\n\n\nclass TestProbe(TransactionCase):\n    def test_default_size(self):\n        self.assertEqual(self.env['koala.probe'].create({'name': 'p'}).size, 1)\n",
};

const odooModule: Scenario = {
  id: 'mechanics-odoo-module',
  name: 'An Odoo module is built and checked in its own Odoo',
  describe: 'Mechanics, on a script: a plan for an Odoo addons tree is approved; the tree starts from the Odoo scaffold in an Odoo 18 workspace with its own Postgres and a browser; a leaf writes a module, its task checks install it into a throwaway database and run its tests, lint the chart, run its browser tests against a throwaway Odoo in Chromium, and read its description, longer than one command\'s output, to its last line, and it lands on main.',
  agent: 'planner',
  procedure: { id: 'planning' },
  input: { message: 'Plan the Odoo check tree.', inputs: { goal: 'odoo check' } },
  script: { rules: [
    { when: { offered: ['propose_plan'], notCalled: ['propose_plan'] }, reply: { call: [{ tool: 'propose_plan', arguments: {
      tree: { name: 'Odoo check', type: ODOO_TREE_TYPE, goal: 'A probe module that installs and passes its tests.' },
      planDoc: '# Odoo check\n\n## Destination\nThe koala_probe module installs into Odoo 18 and its tests pass.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything else.\n',
      branches: [{ title: 'Modules', leaves: [{
        key: 'probe', title: 'Probe module', body: 'koala_probe installs and its tests pass', brief: 'Write the koala_probe module with a test.',
        tasks: [
          { key: 'write', title: 'Write the koala_probe module', description: 'Write koala_probe under addons/ with a model and a test.', role: 'The leaf.', doneMeans: 'odoo-check says PASSED for koala_probe', checks: { command: `odoo-check ${PROBE} addons`, expects: ['odoo-check: PASSED'] } },
          { key: 'chart', title: 'Check the deployment chart', description: 'Lint deploy/chart.', role: 'The leaf.', doneMeans: 'the chart lints clean', dependsOn: ['write'], checks: { command: 'helm lint deploy/chart', expects: ['1 chart(s) linted, 0 chart(s) failed'] } },
          { key: 'browser', title: 'Check it in a browser', description: 'Run the browser tests against an Odoo with the module.', role: 'The leaf.', doneMeans: 'its browser tests pass', dependsOn: ['write'], checks: { e2e: { specs: ['e2e'] } } },
          { key: 'description', title: 'Describe the module', description: 'Give it a description page.', role: 'The leaf.', doneMeans: 'the description reads to its end', dependsOn: ['write'], checks: { contentPath: `addons/${PROBE}/static/description/index.html`, contentPattern: 'koala_probe ends here' } },
        ],
      }] }],
    } }] } },
    { when: { offered: ['propose_plan'] }, reply: { say: 'Proposed; it waits for your approval.' } },
    DECIDE,
    { when: { offered: ['settle_leaf'], notCalled: ['settle_leaf'] }, reply: { call: [{ tool: 'settle_leaf', arguments: { leafId: '{{mentioned.leaf}}', verdict: 'verified', note: 'scripted' } }] } },
    { when: { offered: ['settle_leaf'] }, reply: { say: 'Settled.' } },
    { when: { offered: ['record_verdict'], notCalled: ['record_verdict'] }, reply: { call: [{ tool: 'record_verdict', arguments: { verdict: 'met', reasoning: 'scripted' } }] } },
    { when: { offered: ['record_verdict'] }, reply: { say: 'Met.' } },
    { when: { offered: ['write_file'], asked: 'Work the task Write the koala_probe module', notCalled: ['write_file'] }, reply: { call: Object.entries(PROBE_FILES).map(([path, content]) => ({ tool: 'write_file', arguments: { path, content } })) } },
    { when: { asked: 'Work the task' }, reply: { say: 'Done.' } },
    NOTHING,
  ] },
  expect: { outcome: 'ok', toolsSucceeded: ['propose_plan'] },
  then: [
    { name: 'approving the plan', do: { approvePlan: true }, expect: { repository: { of: 'tree', files: [{ path: 'Dockerfile', contains: ['FROM odoo:18'] }, { path: 'CHECKS.md', contains: ['odoo-check'] }, { path: 'deploy/chart/values.yaml', contains: ['live: a'] }] } } },
    { name: 'the tree runs until quiet', do: { runTree: true }, expect: {
      outcome: 'ok',
      leaves: { verified: 1, landed: { 'Probe module': 'merged' } },
      repository: { of: 'tree', files: [{ path: `addons/${PROBE}/__manifest__.py`, contains: ['18.0.1.0.0'] }] },
    } },
    { name: 'deleting the tree', do: { deleteTree: true }, expect: { workspace: { of: 'tree', exists: false } } },
  ],
};

export const MISSING_FIELD_SPEC = `import { test, expect } from '@playwright/test';

test('a person sees the never-made field on the home page', async ({ page }) => {
  await page.goto('/web/login');
  await page.fill('input[name="login"]', process.env.ODOO_LOGIN!);
  await page.fill('input[name="password"]', process.env.ODOO_PASSWORD!);
  await page.click('button[type="submit"]');
  await expect(page.locator('.o_main_navbar')).toBeVisible();
  await expect(page.locator('[name="koala_never_made"]')).toBeVisible({ timeout: 5_000 });
});
`;

const odooBrowserFailure: Scenario = {
  ...odooModule,
  id: 'mechanics-odoo-browser-failure',
  name: 'A browser test that fails keeps what the browser saw',
  describe: 'Mechanics, on a script: an Odoo leaf\'s module installs, but its browser test looks for a field nobody made, so its check fails; the leaf is settled failed with the failing report, and the screenshot, trace and video Playwright left are kept and open through the API.',
  input: { message: 'Plan the Odoo browser failure tree.', inputs: { goal: 'odoo browser failure' } },
  script: { rules: [
    { when: { offered: ['propose_plan'], notCalled: ['propose_plan'] }, reply: { call: [{ tool: 'propose_plan', arguments: {
      tree: { name: 'Odoo browser failure', type: ODOO_TREE_TYPE, goal: 'A probe module whose browser test fails.' },
      planDoc: '# Odoo browser failure\n\n## Destination\nThe koala_probe module installs; its browser test looks for a field that was never made.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything else.\n',
      branches: [{ title: 'Modules', leaves: [{
        key: 'probe', title: 'Probe in a browser', body: 'koala_probe shows a field in the browser', brief: 'Write koala_probe and a browser test for its field.',
        tasks: [
          { key: 'write', title: 'Write the koala_probe module', description: 'Write koala_probe under addons/ and its browser test under e2e/.', role: 'The leaf.', doneMeans: 'its browser tests pass', checks: { e2e: { specs: ['e2e'] } } },
        ],
      }] }],
    } }] } },
    { when: { offered: ['propose_plan'] }, reply: { say: 'Proposed; it waits for your approval.' } },
    DECIDE,
    { when: { offered: ['settle_leaf'], notCalled: ['settle_leaf'] }, reply: { call: [{ tool: 'settle_leaf', arguments: { leafId: '{{mentioned.leaf}}', verdict: 'verified', note: 'scripted' } }] } },
    { when: { offered: ['settle_leaf'] }, reply: { say: 'Settled.' } },
    { when: { offered: ['record_verdict'], notCalled: ['record_verdict'] }, reply: { call: [{ tool: 'record_verdict', arguments: { verdict: 'met', reasoning: 'scripted' } }] } },
    { when: { offered: ['record_verdict'] }, reply: { say: 'Met.' } },
    { when: { offered: ['write_file'], asked: 'Work the task Write the koala_probe module', notCalled: ['write_file'] }, reply: { call: [...Object.entries(PROBE_FILES), ['e2e/missing-field.spec.ts', MISSING_FIELD_SPEC]].map(([path, content]) => ({ tool: 'write_file', arguments: { path, content } })) } },
    { when: { asked: 'Work the task' }, reply: { say: 'Done.' } },
    NOTHING,
  ] },
  then: [
    { name: 'approving the plan', do: { approvePlan: true }, expect: { repository: { of: 'tree', files: [{ path: 'playwright.config.ts', contains: ['retain-on-failure'] }] } } },
    { name: 'the tree runs until quiet', do: { runTree: true }, expect: {
      outcome: 'ok',
      leaves: {
        verified: 0,
        findings: { 'Probe in a browser': ['FAILED — the browser tests in e2e pass against the workspace\'s own app: 1 passed, 1 failed', 'FAILED — browser test "a person sees the never-made field on the home page" (missing-field.spec.ts): it failed:', 'passed — browser test "a person signs in and reaches the Odoo home"', 'what the browser left behind'] },
        artifacts: { 'Probe in a browser': 2 },
      },
    } },
    { name: 'deleting the tree', do: { deleteTree: true }, expect: { workspace: { of: 'tree', exists: false } } },
  ],
};

export const MECHANICS_CHECKS = (): Scenario[] => [judged, researched, compacted(), logged, landed, deletedProject, odooModule, odooBrowserFailure];
