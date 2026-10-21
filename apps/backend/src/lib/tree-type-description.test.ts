import { describe, it, expect } from 'vitest';
import { browserTestsLine, describeTreeType } from './tree-type-description.js';
import { builtLanguage } from './tree-types.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';
import { WORKSPACE_IMAGE_SEEDS } from './workspace-image-seeds.js';

const seed = (id: string) => TREE_TYPE_SEEDS.find((type) => type.id === id)!;
const image = (id: string) => WORKSPACE_IMAGE_SEEDS.find((entry) => entry.id === id);

describe('a tree type described from the parts that run it', () => {
  it('tells the planner what approval makes, what is installed, how it grows, what the platform releases, and what never to plan', () => {
    const odoo = seed('odoo-addons');
    const text = describeTreeType({ type: odoo, image: image('odoo-20'), growing: 'grove-run: Grows the tree.' });
    expect(text).toContain('VERSIONS\nOdoo 20 (the default) or 18. A new tree is Odoo 20 unless the plan\'s tree sets version;');
    expect(text).toContain('- 18: works in the odoo workspace.');
    expect(text).toContain('  - Access rules are `ir.access` rows in `security/ir.access.csv`');
    expect(text).toContain('Its own worktree in the odoo-20 workspace (Odoo 20): Odoo 20 Community');
    expect(text).toContain('The tree gets a project of its own');
    expect(text).toContain('- deploy/chart/Chart.yaml');
    expect(text).toContain('HOW THE TREE GROWS\ngrove-run: Grows the tree.');
    expect(text).toContain('preview: it runs in that slot on its own preview address');
    expect(text).toContain('THE PLATFORM DOES THESE, SO NEVER PLAN THEM\n- installing the app or its database');
    expect(text).toContain(`DONE MEANS\n${odoo.doneMeans}`);
    expect(text).toContain('SECRETS THE PLATFORM PROVIDES, SO NEVER PLAN MAKING OR STORING THEM\n- POSTGRES_PASSWORD: The password Odoo uses to reach its own PostgreSQL. Put in the project\'s vault when the project is made (the platform makes a random one)');
    expect(text).toContain('and the person can see it to sign in as admin.');
  });

  it('says what the app depends on, and what every leaf runs with and may reach', () => {
    const text = describeTreeType({ type: { ...seed('api-service'), defaultBindings: ['shop-db'], env: [{ name: 'SHOP_CURRENCY', value: 'EUR' }], egress: [{ cidr: '10.1.0.0/16', ports: [5432] }] } });
    expect(text).toContain('WHAT THE APP DEPENDS ON, SO NEVER PLAN DEPLOYING IT\n- shop-db: the platform binds it into every deploy of the app with its credentials');
    expect(text).toContain('Every leaf runs with SHOP_CURRENCY=EUR.');
    expect(text).toContain('It may also reach 10.1.0.0/16 on 5432.');
  });

  it('says an answer type gets no project and has nothing delivered, and nothing the platform owns', () => {
    const text = describeTreeType({ type: seed('research-paper') });
    expect(text).toContain('it gets no project');
    expect(text).toContain('Nothing is built, deployed or exposed');
    expect(text).not.toContain('NEVER PLAN');
  });

  it('says how a type is released, whether there is another way, and that it can start from the client\'s own app', () => {
    const odoo = seed('odoo-addons');
    const only = describeTreeType({ type: odoo, releasing: { own: { slug: 'release', name: 'Release', description: 'prepares each build beside the live app', app: 'odoo' }, others: [], restores: { title: 'Odoo' } } });
    expect(only).toContain('HOW IT IS RELEASED\nIts own way: the release agent (prepares each build beside the live app), with the odoo adapter.');
    expect(only).toContain('This is the only way that fits it, so there is nothing to ask the person about releasing; never set release in the plan.');
    expect(only).toContain('STARTING FROM THE CLIENT\'S OWN APP\nWhen the client already runs this app, the plan\'s tree sets startsFrom: \'client-database\'.');
    expect(only).toContain('the zip Odoo\'s database manager makes');
    const two = describeTreeType({ type: odoo, releasing: { own: { slug: 'release', name: 'Release', app: 'odoo' }, others: [{ slug: 'release-careful', name: 'Careful', app: 'odoo' }] } });
    expect(two).toContain('- the release-careful agent, with the odoo adapter: release: { agent: \'release-careful\', app: \'odoo\' }.');
    expect(two).not.toContain('STARTING FROM THE CLIENT');
    expect(describeTreeType({ type: seed('research-paper'), releasing: { own: { slug: 'release', name: 'Release' }, others: [] } })).not.toContain('HOW IT IS RELEASED');
  });
});

describe('whether a tree type\'s workspace runs browser tests', () => {
  it('says so for an Odoo image and for a starter that turns them on, and says how to get them otherwise', () => {
    expect(browserTestsLine(seed('odoo-addons'), image('odoo-20'))).toMatch(/^Browser tests: yes\. Its image has koala-e2e/);
    expect(browserTestsLine(seed('ui-app'), image('node'))).toMatch(/^Browser tests: yes\. The starter's \.koala\/workspace\.json turns them on/);
    expect(browserTestsLine(seed('api-service'), image('node'))).toMatch(/^Browser tests: not built in\. .*change_workspace with needs: \["koala-e2e"\]/);
  });

  it('describes the workspace a type with no particular language is really built in', () => {
    const paper = seed('research-paper');
    expect(builtLanguage(paper.language)).toBe('node');
    expect(describeTreeType({ type: paper, image: image(builtLanguage(paper.language)) })).toContain('in the node workspace');
  });
});

describe('what a tree could be given', () => {
  it('lists the dependencies its workspace does not have, from the person\'s catalogue', () => {
    const text = describeTreeType({ type: seed('api-service'), image: image('node'), canGet: [{ name: 'koala-e2e', summary: 'Runs browser tests.' }, { name: 'pdf-tools', summary: 'PDF tools.' }] });
    expect(text).toContain('It can be given any of these with change_workspace (needs) or .koala/workspace.json: koala-e2e (Runs browser tests); pdf-tools (PDF tools).');
  });
});
