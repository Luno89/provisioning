import { describe, it, expect } from 'vitest';
import { runningItems, type RunningRecords, type RunningWorkflow } from './running.js';

const records: RunningRecords = {
  trees: [{ id: 't1', name: 'Delivery Labels' }],
  projects: [{ id: 'p1', name: 'Shop' }],
  conversations: [{ id: 'c1', title: 'Labels for the warehouse' }],
  checkRuns: [
    { id: 'bench1', trigger: { kind: 'changed', agents: ['koala'] }, finished: 14, scenarios: Array(22).fill(0) },
    { id: 'mine', trigger: { kind: 'manual' }, finished: 0, scenarios: [0] },
  ],
  releases: [{ projectId: 'p1', commit: '57fce1a0ffff', state: 'preview' }],
  agentName: (slug) => ({ koala: 'Koala', executor: 'Executor' } as Record<string, string>)[slug],
};

const at = (n: number) => `2026-10-16T15:0${n}:00Z`;
const flow = (workflowId: string, type: string, n: number, over: Partial<RunningWorkflow> = {}): RunningWorkflow => ({ workflowId, type, startedAt: at(n), ...over });

describe('what is running, in plain words', () => {
  it('names each kind of work by what it is for, newest first, with where it opens and how it stops', () => {
    const items = runningItems([
      flow('check-run-bench1', 'CheckRunWorkflow', 1),
      flow('check-run-mine', 'CheckRunWorkflow', 2),
      flow('grove-run-t1', 'AgentRunWorkflow', 3, { memo: { runId: 'grove-run-t1~abc' } }),
      flow('release-p1', 'AgentRunWorkflow', 4, { memo: { runId: 'release-p1~x', agent: 'release' } }),
      flow('memory-conversation-c1-8', 'AgentRunWorkflow', 5, { memo: { runId: 'memory-conversation-c1-8', agent: 'memory-keeper', about: 'the conversation "Labels for the warehouse"' } }),
      flow('run-r1', 'AgentRunWorkflow', 6, { memo: { runId: 'run-r1', agent: 'koala', conversation: 'c1' } }),
      flow('workspace-build-t1-abc123', 'AgentRunWorkflow', 7, { memo: { runId: 'workspace-build-t1-abc123', agent: 'workspace' } }),
      flow('remove-project-p1', 'RemoveProjectWorkflow', 8),
      flow('weird-1', 'SomethingNewWorkflow', 9),
    ], records);

    expect(items.map((item) => [item.kind, item.title, item.opens, item.cancel])).toEqual([
      ['other', 'SomethingNewWorkflow (weird-1)', { kind: 'temporal', id: 'weird-1' }, { via: 'workflow' }],
      ['removal', 'Deleting the project Shop', { kind: 'temporal', id: 'remove-project-p1' }, { via: 'none', why: 'deleting cannot be stopped part way' }],
      ['workspace-build', 'Building the workspace of Delivery Labels', { kind: 'tree', id: 't1' }, { via: 'run', runId: 'workspace-build-t1-abc123' }],
      ['chat', 'Koala answering in "Labels for the warehouse"', { kind: 'chat', id: 'c1' }, { via: 'run', runId: 'run-r1' }],
      ['memory-keeper', 'The memory keeper, reading the conversation "Labels for the warehouse"', { kind: 'temporal', id: 'memory-conversation-c1-8' }, { via: 'run', runId: 'memory-conversation-c1-8' }],
      ['release', 'Releasing Shop: 57fce1a0 waits for you on its card', { kind: 'project', id: 'p1' }, { via: 'run', runId: 'release-p1~x' }],
      ['tree', 'Tree run: Delivery Labels', { kind: 'tree', id: 't1' }, { via: 'tree', treeId: 't1' }],
      ['check', 'Checks you started: 0 of 1 check', { kind: 'checks', id: 'mine' }, { via: 'check', id: 'mine' }],
      ['bench', 'The bench, checking Koala: 14 of 22 checks', { kind: 'checks', id: 'bench1' }, { via: 'check', id: 'bench1' }],
    ]);
  });

  it('leaves out the runs other work started, and the countdowns that only wait', () => {
    const items = runningItems([
      flow('grove-run-t1', 'AgentRunWorkflow', 1),
      flow('grove-run-t1~abc-grove-leaf-1', 'AgentRunWorkflow', 2, { parent: 'grove-run-t1' }),
      flow('conclude-conversation-c1', 'ConversationConclusionWorkflow', 3),
      flow('bench-idle-u1', 'BenchIdleWorkflow', 4),
    ], records);
    expect(items.map((item) => item.workflowId)).toEqual(['grove-run-t1']);
  });

  it('still says something useful about a run from before runs said what they were', () => {
    expect(runningItems([flow('run-old', 'AgentRunWorkflow', 1)], records)[0]).toMatchObject({ kind: 'run', title: 'An agent at work', cancel: { via: 'run', runId: 'run-old' } });
  });
});
