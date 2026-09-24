import { describe, it, expect } from 'vitest';
import { parsePlan, planSummary } from './plan-proposals.js';

const world = { treeTypes: ['api-service', 'research'], existingLeafIds: new Set(['old-leaf']) };

const task = (over: Record<string, unknown> = {}) => ({
  key: 't1',
  title: 'Write the handler',
  description: 'Add GET /health returning the build sha, wired into the router',
  role: 'Gives the deploy check something to probe',
  doneMeans: 'curl /health answers 200 with the sha',
  ...over,
});

const leaf = (over: Record<string, unknown> = {}) => ({
  key: 'health',
  title: 'Health endpoint',
  body: 'GET /health answers 200 with the running build sha',
  brief: 'Express app in src/server.ts; keep it dependency-free.',
  tasks: [task()],
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({
  tree: { name: 'Widget API', type: 'api-service', goal: 'A small API' },
  planDoc: '# Widget API\n\n## Destination\nA deployed API answering /health.\n\n## Not yet specified\nWhether the cluster has an ingress.\n\n## Out of scope\nNone',
  branches: [{ title: 'Operability', leaves: [leaf()] }],
  ...over,
});

const problemOf = (raw: Record<string, unknown>) => {
  const parsed = parsePlan(raw, world);
  return 'problem' in parsed ? parsed.problem : undefined;
};

describe('parsePlan', () => {
  it('takes a whole plan for a new tree, briefs and all', () => {
    const parsed = parsePlan(plan(), world);

    expect(parsed).toMatchObject({
      plan: {
        tree: { name: 'Widget API', type: 'api-service' },
        branches: [{ title: 'Operability', leaves: [{ key: 'health', brief: expect.stringContaining('src/server.ts'), tasks: [{ key: 't1', dependsOn: [] }] }] }],
      },
    });
    expect('plan' in parsed && planSummary(parsed.plan)).toBe('1 branch, 1 leaf, 1 task for a new api-service tree "Widget API"');
  });

  it('extends an existing tree by id', () => {
    const parsed = parsePlan(plan({ tree: undefined, treeId: 'tree-1' }), world);
    expect(parsed).toMatchObject({ plan: { treeId: 'tree-1' } });
  });

  it('names the tree types the person actually has when the type is wrong', () => {
    expect(problemOf(plan({ tree: { name: 'x', type: 'spaceship' } }))).toBe('a new tree needs a type this person has: api-service, research — "spaceship" is not one of them');
    expect(problemOf(plan({ tree: undefined }))).toMatch(/treeId for an existing tree/);
  });

  it('insists on the plan doc, a checkable body and a brief for every leaf', () => {
    expect(problemOf(plan({ planDoc: '' }))).toMatch(/becomes PLAN.md/);
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [leaf({ body: '' })] }] }))).toMatch(/end state a later judge checks/);
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [leaf({ brief: '' })] }] }))).toMatch(/leaves\/<leaf>.md/);
  });

  it('holds every task to the same brief propose_work does', () => {
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [leaf({ tasks: [task({ role: '' })] })] }] })))
      .toBe('leaf "health", task "Write the handler": a task under a leaf needs to say what part it plays in the overall project — which goal it serves and what it makes possible');
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [leaf({ tasks: [task({ doneMeans: '' })] })] }] }))).toMatch(/what "done" means/);
  });

  it('keeps task order inside the leaf and refuses circles', () => {
    const outside = leaf({ tasks: [task({ dependsOn: ['elsewhere'] })] });
    const circle = leaf({ tasks: [task({ key: 'a', dependsOn: ['b'] }), task({ key: 'b', dependsOn: ['a'] })] });

    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [outside] }] }))).toMatch(/not a task of the same leaf/);
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [circle] }] }))).toMatch(/in a circle: a → b → a/);
  });

  it('lets leaves wait on plan leaves or the tree\'s own leaves, and nothing else', () => {
    const second = leaf({ key: 'deploy', title: 'Deploy', dependsOn: ['health', 'old-leaf'] });
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [leaf(), second] }] }))).toBeUndefined();

    const ghost = leaf({ key: 'deploy', title: 'Deploy', dependsOn: ['ghost'] });
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [leaf(), ghost] }] }))).toMatch(/neither a leaf of this plan nor a leaf of the tree/);

    const looped = [leaf({ dependsOn: ['deploy'] }), leaf({ key: 'deploy', title: 'Deploy', dependsOn: ['health'] })];
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: looped }] }))).toMatch(/leaves wait on each other in a circle/);
  });

  it('refuses duplicate keys and an empty plan', () => {
    expect(problemOf(plan({ branches: [{ title: 'B', leaves: [leaf(), leaf()] }] }))).toMatch(/two leaves are keyed "health"/);
    expect(problemOf(plan({ branches: [] }))).toMatch(/at least one branch/);
  });

  it('takes nested lists and objects a model sent as JSON text', () => {
    const raw = plan();
    const parsed = parsePlan({ ...raw, tree: JSON.stringify(raw.tree), branches: JSON.stringify(raw.branches) }, world);

    expect(parsed).toMatchObject({ plan: { tree: { name: 'Widget API' }, branches: [{ title: 'Operability', leaves: [{ key: 'health', tasks: [{ key: 't1' }] }] }] } });
  });

  it('says so plainly when branches is text that is not a list', () => {
    expect(problemOf(plan({ branches: 'one branch, two leaves' }))).toMatch(/branches has to be a list/);
  });

  it('asks for the destination, the fog and the out-of-scope sections, and names what each is for', () => {
    expect(problemOf(plan({ planDoc: '# Widget API\n\n## Destination\nA deployed API.' })))
      .toBe('the planDoc is missing "## Not yet specified" (what is in scope but not sharp enough to plan yet, and every fact the plan rests on that nobody has checked) and "## Out of scope" (what this tree deliberately will not do). Write "None" under a heading that has nothing to say');
    expect(problemOf(plan({ planDoc: '## destination\nx\n### Not yet specified\nNone\n## Out of scope\nNone' }))).toBeUndefined();
  });

  it('forgives surplus closing brackets at the end of JSON text, and says where text that still does not parse went wrong', () => {
    const raw = plan();
    const surplus = `${JSON.stringify(raw.branches)}}`;
    expect(parsePlan({ ...raw, branches: surplus }, world)).toMatchObject({ plan: { branches: [{ title: 'Operability' }] } });

    const broken = JSON.stringify(raw.branches).replace('"leaves":', '"leaves"');
    expect(problemOf(plan({ branches: broken }))).toMatch(/not a JSON list \(.+position \d+.*\)\. Send branches as a JSON array, not a string/);
  });
});

