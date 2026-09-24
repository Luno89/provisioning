import { describe, it, expect } from 'vitest';
import { leafBriefPath, planDocuments, renderLeafBrief, renderPlanDoc } from './plan-documents.js';
import type { AdoptedPlan, Plan } from './plan-proposals.js';

const plan: Plan = {
  tree: { name: 'Widget API', type: 'api-service' },
  planDoc: '# Widget API\n\nAssumption: Node 22.',
  branches: [{
    title: 'Operability',
    leaves: [
      {
        key: 'health', title: 'Health endpoint', body: 'GET /health answers 200 with the sha', brief: 'Keep it dependency-free.', dependsOn: [],
        tasks: [
          { key: 'a', title: 'Handler', description: 'Write the handler', role: 'The probe target', doneMeans: 'curl answers 200', dependsOn: [] },
          { key: 'b', title: 'Test', description: 'Cover it', role: 'Keeps it honest', doneMeans: 'the test passes', dependsOn: ['a'] },
        ],
      },
      { key: 'deploy', title: 'Deploy', body: 'The service runs in the cluster', brief: 'Use the chart.', dependsOn: ['health'], tasks: [] },
    ],
  }],
};

const adopted: AdoptedPlan = {
  treeId: 'tree-1',
  branchIds: ['branch-1'],
  leafIds: { health: 'leaf-h', deploy: 'leaf-d' },
  taskIds: { 'health/a': 'task-a', 'health/b': 'task-b' },
};

describe('the plan documents', () => {
  it('writes PLAN.md as the planner\'s words, then an index of the grove with real ids and brief links', () => {
    const doc = renderPlanDoc(plan, adopted, 'Widget API');

    expect(doc.startsWith('# Widget API\n\nAssumption: Node 22.')).toBe(true);
    expect(doc).toContain('## The grove: Widget API (`tree-1`)');
    expect(doc).toContain('- **Health endpoint** (`leaf-h`, 2 tasks) — brief: [leaves/leaf-h.md](leaves/leaf-h.md)');
    expect(doc).toContain('- **Deploy** (`leaf-d`, 0 tasks) — waits on `leaf-h` — brief: [leaves/leaf-d.md](leaves/leaf-d.md)');
  });

  it('writes a leaf brief with the judged goal, the brief and every task\'s whole brief', () => {
    const brief = renderLeafBrief(plan.branches[0]!.leaves[0]!, adopted, 'Operability');

    expect(brief).toContain('Leaf `leaf-h` on branch "Operability"');
    expect(brief).toContain('## The goal the judge checks\n\nGET /health answers 200 with the sha');
    expect(brief).toContain('### Test (`task-b`)\n\nCover it\n\n- **Its part in the project:** Keeps it honest\n- **Done means:** the test passes\n- **After:** `task-a`');
  });

  it('says a leaf with no tasks is planned, not broken down', () => {
    expect(renderLeafBrief(plan.branches[0]!.leaves[1]!, adopted, 'Operability')).toContain('None yet — this leaf is planned, not broken down.');
  });

  it('produces PLAN.md and one brief per leaf, at the paths the runs are pointed at', () => {
    expect(planDocuments(plan, adopted, 'Widget API').map((doc) => doc.path)).toEqual(['PLAN.md', leafBriefPath('leaf-h'), leafBriefPath('leaf-d')]);
  });
});
