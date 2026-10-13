import type { FlowStage, Scenario } from './scenario.js';
import { ODOO_TREE_TYPE } from '../../lib/tree-type-seeds.js';

export const COLOUR_MODULE = 'koala_colour';
export const COLOUR_FIELD = 'koala_colour';
export const COLOUR_TEST = 'a person sees the Koala colour field on a new contact';
const SIGN_IN_TEST = 'a person signs in and reaches the Odoo home';

const colourSpec = (title: string) => `import { test, expect } from '@playwright/test';

test('${title}', async ({ page }) => {
  await page.goto('/web/login');
  await page.fill('input[name="login"]', process.env.ODOO_LOGIN!);
  await page.fill('input[name="password"]', process.env.ODOO_PASSWORD!);
  await page.click('button[type="submit"]');
  await expect(page.locator('.o_main_navbar')).toBeVisible();
  await page.goto('/odoo/action-base.action_partner_form/new');
  await expect(page.locator('.o_field_widget[name="${COLOUR_FIELD}"]')).toBeVisible();
});
`;

export const COLOUR_FILES: Record<string, string> = {
  [`addons/${COLOUR_MODULE}/__init__.py`]: 'from . import models\n',
  [`addons/${COLOUR_MODULE}/__manifest__.py`]: "{\n    'name': 'Koala colour',\n    'version': '18.0.1.0.0',\n    'depends': ['base'],\n    'data': ['views/res_partner_views.xml'],\n    'license': 'LGPL-3',\n}\n",
  [`addons/${COLOUR_MODULE}/models/__init__.py`]: 'from . import res_partner\n',
  [`addons/${COLOUR_MODULE}/models/res_partner.py`]: `from odoo import fields, models\n\n\nclass ResPartner(models.Model):\n    _inherit = 'res.partner'\n\n    ${COLOUR_FIELD} = fields.Char('Koala colour')\n`,
  [`addons/${COLOUR_MODULE}/views/res_partner_views.xml`]: [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<odoo>',
    '    <record id="view_partner_form_koala_colour" model="ir.ui.view">',
    '        <field name="name">res.partner.form.koala.colour</field>',
    '        <field name="model">res.partner</field>',
    '        <field name="inherit_id" ref="base.view_partner_form"/>',
    '        <field name="arch" type="xml">',
    '            <field name="vat" position="after">',
    `                <field name="${COLOUR_FIELD}"/>`,
    '            </field>',
    '        </field>',
    '    </record>',
    '</odoo>',
    '',
  ].join('\n'),
  'e2e/koala-colour.spec.ts': colourSpec(COLOUR_TEST),
};

const LIVE_TEST = 'a person sees the Koala colour field on a new contact in the live app';

const releaseStages = (gate: Record<string, 'passed'>): FlowStage[] => [
  { name: 'the field waits in preview, tested in a browser', do: { waitRelease: { state: 'preview' } }, expect: { release: { state: 'preview', e2e: { state: 'passed', tests: gate } } } },
  { name: 'cutting over', do: { cutOver: true }, expect: { release: { state: 'live' } } },
  { name: 'browsing the live app', do: { browse: { release: 'live', specs: { 'e2e/live-colour.spec.ts': colourSpec(LIVE_TEST) } } }, expect: { e2e: { state: 'passed', tests: { [LIVE_TEST]: 'passed' } } } },
  { name: 'removing the app', do: { removeRelease: true }, expect: { release: { exists: false } } },
  { name: 'deleting the project', do: { deleteProject: true }, expect: { outcome: 'ok', project: { exists: false } } },
];

const DECIDE = { when: { asked: '^Question: ' }, reply: { say: 'yes' } };
const NOTHING = { when: {}, reply: { say: 'Nothing to do here.' } };

const scripted: Scenario = {
  id: 'story-odoo-field-scripted',
  name: 'An Odoo field goes from a plan to the live app',
  describe: 'The whole Odoo story, on a script: a plan for the check\'s project is approved and its Odoo starter goes live in slot a; a leaf adds a field to the contact form with a browser test, proven in the workspace\'s own Odoo, and lands; the build waits in preview on a copy of live, where its browser tests pass signed in as the test user; it is cut over, the live app is browsed and the field is there; then the app and the project are removed.',
  agent: 'planner',
  procedure: { id: 'planning' },
  input: { message: 'Plan the Koala colour field.', inputs: { goal: 'koala colour field', projectId: '{{world.projectId}}' } },
  world: { project: { name: 'odoo-story' } },
  script: { rules: [
    { when: { offered: ['propose_plan'], notCalled: ['propose_plan'] }, reply: { call: [{ tool: 'propose_plan', arguments: {
      tree: { name: 'Koala colour', type: ODOO_TREE_TYPE, goal: 'Contacts have a Koala colour field a person sees on the form.' },
      planDoc: '# Koala colour\n\n## Destination\nThe contact form shows a Koala colour field.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything else.\n',
      branches: [{ title: 'Contacts', leaves: [{
        key: 'colour', title: 'Colour field', body: 'the contact form shows Koala colour', brief: 'Add koala_colour to contacts and a browser test that sees it.',
        tasks: [
          { key: 'write', title: 'Write the koala_colour module', description: 'Write koala_colour under addons/ and its browser test under e2e/.', role: 'The leaf.', doneMeans: 'odoo-check says PASSED for koala_colour', checks: { command: `odoo-check ${COLOUR_MODULE} addons`, expects: ['odoo-check: PASSED'] } },
          { key: 'browser', title: 'See it in a browser', description: 'Run the browser tests against an Odoo with the module.', role: 'The leaf.', doneMeans: 'its browser tests pass', dependsOn: ['write'], checks: { e2e: { specs: ['e2e'] } } },
        ],
      }] }],
    } }] } },
    { when: { offered: ['propose_plan'] }, reply: { say: 'Proposed; it waits for your approval.' } },
    DECIDE,
    { when: { offered: ['settle_leaf'], notCalled: ['settle_leaf'] }, reply: { call: [{ tool: 'settle_leaf', arguments: { leafId: '{{mentioned.leaf}}', verdict: 'verified', note: 'scripted' } }] } },
    { when: { offered: ['settle_leaf'] }, reply: { say: 'Settled.' } },
    { when: { offered: ['record_verdict'], notCalled: ['record_verdict'] }, reply: { call: [{ tool: 'record_verdict', arguments: { verdict: 'met', reasoning: 'scripted' } }] } },
    { when: { offered: ['record_verdict'] }, reply: { say: 'Met.' } },
    { when: { offered: ['write_file'], asked: 'Work the task Write the koala_colour module', notCalled: ['write_file'] }, reply: { call: Object.entries(COLOUR_FILES).map(([path, content]) => ({ tool: 'write_file', arguments: { path, content } })) } },
    { when: { asked: 'Work the task' }, reply: { say: 'Done.' } },
    NOTHING,
  ] },
  expect: { outcome: 'ok', toolsSucceeded: ['propose_plan'] },
  then: [
    { name: 'approving the plan into the project', do: { approvePlan: true }, expect: { repository: { of: 'tree', files: [{ path: 'deploy/chart/values.yaml', contains: ['live: a'] }, { path: 'e2e/signs-in.spec.ts' }] } } },
    { name: 'the starter goes live', do: { waitRelease: { state: 'live' } }, expect: { release: { state: 'live' } } },
    { name: 'the tree runs until quiet', do: { runTree: true }, expect: {
      outcome: 'ok',
      leaves: { verified: 1, landed: { 'Colour field': 'merged' } },
      repository: { of: 'tree', files: [{ path: `addons/${COLOUR_MODULE}/views/res_partner_views.xml`, contains: [COLOUR_FIELD] }] },
    } },
    ...releaseStages({ [SIGN_IN_TEST]: 'passed', [COLOUR_TEST]: 'passed' }),
  ],
};

const modelled: Scenario = {
  id: 'story-odoo-field',
  onBench: false,
  name: 'A described Odoo field reaches the live app',
  describe: 'The whole Odoo story, on your model: the planner is asked for a field on the contact form; the plan is approved into the check\'s project and its starter goes live; the tree is grown until quiet, so the field is written, proven in a browser in the workspace, and landed; the build waits in preview where the project\'s own browser tests pass; it is cut over, and the check\'s own browser test finds the field in the live app; then the app and the project are removed.',
  agent: 'planner',
  procedure: { id: 'planning' },
  input: {
    message: [
      'This Odoo 18 project needs a new text field on contacts.',
      `Make a module named ${COLOUR_MODULE} in the project's addons that adds a Char field ${COLOUR_FIELD}, labelled "Koala colour", to res.partner, and shows it on the contact form (base.view_partner_form) right after the tax ID field (vat).`,
      'Keep it to one branch and one leaf. The leaf is done when the module installs and its tests pass, and when a browser test under e2e/ signs in, opens a new contact and sees the field.',
    ].join(' '),
    inputs: { goal: 'A Koala colour field on the contact form', projectId: '{{world.projectId}}' },
  },
  world: { project: { name: 'odoo-story' } },
  expect: { outcome: 'ok', toolsSucceeded: ['propose_plan'] },
  then: [
    { name: 'approving the plan into the project', do: { approvePlan: true }, expect: { repository: { of: 'tree', files: [{ path: 'deploy/chart/values.yaml', contains: ['live: a'] }] } } },
    { name: 'the starter goes live', do: { waitRelease: { state: 'live' } }, expect: { release: { state: 'live' } } },
    { name: 'the tree runs until quiet', do: { runTree: true }, expect: { outcome: 'ok', repository: { of: 'tree', files: [{ path: `addons/${COLOUR_MODULE}/__manifest__.py` }] } } },
    ...releaseStages({ [SIGN_IN_TEST]: 'passed' }),
  ],
};

const SHOP_GOAL = 'A new Odoo 18 shop whose contacts have a Koala colour field.';

const fromChat: Scenario = {
  id: 'story-odoo-new-project-scripted',
  name: 'A new Odoo project asked for in chat goes live',
  describe: 'The way a person starts, on a script: in a fresh chat about no project, Koala hands the request to the planner, which reads what an Odoo tree becomes — put together from what runs it — and proposes a new Odoo tree; approving it gives the tree a project of its own — a repository holding the Odoo starter and the plan, a build webhook, the person\'s own cluster — whose first build goes live in slot a by itself while the approved tree starts growing; the project\'s channel is told when the starter goes live; a plain message there starts no turn; asked with @koala in the channel, Koala has the message and the notice, and reads the tree and the releases; then deleting the project takes the running app with it.',
  agent: 'koala',
  procedure: { id: 'interactive-chat' },
  input: { message: `I would like ${SHOP_GOAL.charAt(0).toLowerCase()}${SHOP_GOAL.slice(1)}` },
  script: { rules: [
    { when: { asked: 'how is it going', offered: ['project_releases', 'read_tree'], notCalled: ['project_releases'] }, reply: { call: [{ tool: 'read_tree', arguments: {} }, { tool: 'project_releases', arguments: {} }] } },
    { when: { asked: 'how is it going', called: ['project_releases'] }, reply: { say: 'The starter is live, and the tree is growing on its own.' } },
    { when: { offered: ['planner'], notCalled: ['planner'] }, reply: { call: [{ tool: 'planner', arguments: { goal: SHOP_GOAL } }] } },
    { when: { offered: ['planner'], called: ['planner'] }, reply: { say: 'The plan is on the card; approve it and the shop is made.' } },
    { when: { offered: ['describe_tree_type'], notCalled: ['describe_tree_type'] }, reply: { call: [{ tool: 'describe_tree_type', arguments: { type: ODOO_TREE_TYPE } }] } },
    { when: { offered: ['propose_plan'], called: ['describe_tree_type'], notCalled: ['propose_plan'] }, reply: { call: [{ tool: 'propose_plan', arguments: {
      tree: { name: 'Koala shop', type: ODOO_TREE_TYPE, goal: SHOP_GOAL },
      planDoc: '# Koala shop\n\n## Destination\nAn Odoo 18 shop whose contact form shows a Koala colour field.\n\n## Not yet specified\nNothing.\n\n## Out of scope\nEverything else.\n',
      branches: [{ title: 'Contacts', leaves: [{
        key: 'colour', title: 'Colour field', body: 'the contact form shows Koala colour', brief: 'Add koala_colour to contacts.',
        tasks: [{ key: 'write', title: 'Write the koala_colour module', description: 'Write koala_colour under addons/.', role: 'The leaf.', doneMeans: 'odoo-check says PASSED for koala_colour', checks: { command: `odoo-check ${COLOUR_MODULE} addons`, expects: ['odoo-check: PASSED'] } }],
      }] }],
    } }] } },
    { when: { offered: ['propose_plan'] }, reply: { say: 'Proposed; it waits for your approval.' } },
    NOTHING,
  ] },
  expect: { outcome: 'ok', handOffs: [{ agent: 'planner' }], modelSaw: { anyRequest: true, contains: ['WHEN THE PLAN IS APPROVED', 'THE PLATFORM DOES THESE, SO NEVER PLAN THEM', 'The grove agent grows it', 'cutting-over: the live slot goes into maintenance'] } },
  then: [
    { name: 'approving the plan makes the project', do: { approvePlan: true }, expect: { project: { exists: true }, repository: { of: 'tree', files: [{ path: 'deploy/chart/values.yaml', contains: ['live: a'] }, { path: 'e2e/signs-in.spec.ts' }, { path: 'PLAN.md' }] } } },
    { name: 'the starter goes live by itself', do: { waitRelease: { state: 'live' } }, expect: { release: { state: 'live' } } },
    { name: 'a plain message in the channel', do: { post: { message: 'The shop opens at 9 every day.', in: 'channel' } }, expect: {} },
    { name: 'Koala says how it is going, in the channel', do: { chat: { message: '@koala so how is it going?', in: 'channel' } }, expect: { outcome: 'ok', toolsSucceeded: ['read_tree', 'project_releases'], modelSaw: { anyRequest: true, contains: ['The shop opens at 9 every day.', 'Live: ', 'in slot a.', 'From the platform, not the person: ', ' is live in slot a.'], lacks: ['It is not growing.'] } } },
    { name: 'deleting the project takes its app with it', do: { deleteProject: true }, expect: { outcome: 'ok', project: { exists: false }, release: { exists: false } } },
  ],
};

export const STORY_CHECKS = (): Scenario[] => [scripted, fromChat, modelled];
