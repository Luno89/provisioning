import { describe, it, expect } from 'vitest';
import { parseLeafPlan, parsePlan, planSummary } from './plan-proposals.js';

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

describe('parseLeafPlan', () => {
  const world = { treeId: 't1', leafId: 'leaf-1', leafTitle: 'Serve it', leafBody: 'curl :8080 returns the page' };
  const raw = (over: Record<string, unknown> = {}) => ({
    mode: 'replan',
    why: 'nginx is not installed; python3 is, so serve with its http.server',
    brief: 'Serve site/ with python3 -m http.server 8080.',
    tasks: [task({ key: 'serve', title: 'Serve with python' })],
    ...over,
  });

  it('takes new tasks and a brief for one leaf, keeping the goal unless it is amended', () => {
    const parsed = parseLeafPlan(raw(), world);
    expect(parsed).toMatchObject({ plan: { treeId: 't1', leafId: 'leaf-1', mode: 'replan', brief: expect.stringContaining('http.server'), tasks: [{ key: 'serve' }] } });
    expect('plan' in parsed && parsed.plan.body).toBeFalsy();
    expect(parseLeafPlan(raw({ body: 'curl :8080 returns the page, served by any web server' }), world)).toMatchObject({ plan: { body: 'curl :8080 returns the page, served by any web server' } });
  });

  it('asks for the mode, the why, a brief and at least one task, with task briefs held to the usual rules', () => {
    expect(parseLeafPlan(raw({ mode: 'retry' }), world)).toMatchObject({ problem: expect.stringContaining("'replan'") });
    expect(parseLeafPlan(raw({ why: '' }), world)).toMatchObject({ problem: expect.stringContaining('needs a why') });
    expect(parseLeafPlan(raw({ brief: '' }), world)).toMatchObject({ problem: expect.stringContaining('needs a brief') });
    expect(parseLeafPlan(raw({ tasks: [] }), world)).toMatchObject({ problem: expect.stringContaining('at least one task') });
    expect(parseLeafPlan(raw({ tasks: JSON.stringify([task({ role: '' })]) }), world)).toMatchObject({ problem: expect.stringContaining('what part it plays') });
  });
});


describe('a new tree\'s service name', () => {
  const trees = [{ id: 't0', ownerId: 'u1', name: 'Old widgets', serviceName: 'widgets', projectIds: ['p0'] }, { id: 't9', ownerId: 'u2', name: 'Theirs', serviceName: 'gadgets', projectIds: ['p9'] }];
  const withTrees = { ...world, ownerId: 'u1', trees };

  it('is kept, and says which of the person\'s trees already uses it', () => {
    const parsed = parsePlan(plan({ tree: { name: 'Widget API', type: 'api-service', serviceName: 'widgets' } }), withTrees);
    expect(parsed).toMatchObject({ plan: { tree: { serviceName: 'widgets', joins: { treeId: 't0', treeName: 'Old widgets', projectId: 'p0' } } } });
  });

  it('does not claim anyone else\'s, and refuses a name that is not one', () => {
    expect(parsePlan(plan({ tree: { name: 'Gadget API', type: 'api-service', serviceName: 'gadgets' } }), withTrees)).toMatchObject({ plan: { tree: { serviceName: 'gadgets' } } });
    expect((parsePlan(plan({ tree: { name: 'Gadget API', type: 'api-service', serviceName: 'gadgets' } }), withTrees) as { plan: { tree: { joins?: unknown } } }).plan.tree.joins).toBeUndefined();
    expect(problemOf(plan({ tree: { name: 'X', type: 'api-service', serviceName: 'a very long service name here' } }))).toContain('serviceName is a short name');
  });
});
