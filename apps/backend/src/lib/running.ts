export interface RunningWorkflow {
  workflowId: string;
  type: string;
  startedAt: string;
  parent?: string | undefined;
  memo?: Readonly<Record<string, unknown>> | undefined;
}

export interface RunningRecords {
  trees: readonly { id: string; name: string }[];
  projects: readonly { id: string; name: string }[];
  conversations: readonly { id: string; title?: string | undefined }[];
  checkRuns: readonly { id: string; trigger?: { kind?: string | undefined; agents?: readonly string[] | undefined } | undefined; finished?: number | undefined; scenarios?: readonly unknown[] | undefined }[];
  releases: readonly { projectId: string; commit: string; state: string }[];
  agentName: (slug: string) => string | undefined;
}

export type RunningKind = 'bench' | 'check' | 'memory-keeper' | 'tree' | 'release' | 'chat' | 'run' | 'workspace-build' | 'plan' | 'removal' | 'save' | 'deploy' | 'other';

export type CancelHow =
  | { via: 'check'; id: string }
  | { via: 'tree'; treeId: string }
  | { via: 'run'; runId: string }
  | { via: 'workflow' }
  | { via: 'none'; why: string };

export type OpensAt = { kind: 'chat' | 'tree' | 'project' | 'checks' | 'temporal'; id?: string | undefined };

export interface RunningItem {
  workflowId: string;
  kind: RunningKind;
  title: string;
  since: string;
  opens: OpensAt;
  cancel: CancelHow;
  asking?: string[] | undefined;
}

export const HIDDEN_TYPES: readonly string[] = ['ConversationConclusionWorkflow', 'BenchIdleWorkflow'];

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
const afterPrefix = (id: string, prefix: string): string | undefined => (id.startsWith(prefix) ? id.slice(prefix.length) : undefined);

function agentRun(workflow: RunningWorkflow, records: RunningRecords): Omit<RunningItem, 'workflowId' | 'since'> {
  const id = workflow.workflowId;
  const runId = text(workflow.memo?.runId) ?? id;
  const agent = text(workflow.memo?.agent);
  const about = text(workflow.memo?.about);
  const named = agent ? records.agentName(agent) ?? agent : undefined;
  const asRun: CancelHow = { via: 'run', runId };

  const tree = afterPrefix(id, 'grove-run-');
  if (tree) {
    const name = records.trees.find((entry) => entry.id === tree)?.name;
    return { kind: 'tree', title: `Tree run: ${name ?? 'a tree that is gone'}`, opens: { kind: 'tree', id: tree }, cancel: { via: 'tree', treeId: tree } };
  }
  const project = afterPrefix(id, 'release-');
  if (project) {
    const name = records.projects.find((entry) => entry.id === project)?.name ?? 'a project that is gone';
    const release = records.releases.find((entry) => entry.projectId === project && ['queued', 'preparing', 'preview', 'cutting-over', 'rolling-back'].includes(entry.state));
    const doing = !release ? '' : release.state === 'preview' ? `: ${release.commit.slice(0, 8)} waits for you on its card` : `: ${release.commit.slice(0, 8)} is ${release.state.replace('-', ' ')}`;
    return { kind: 'release', title: `Releasing ${name}${doing}`, opens: { kind: 'project', id: project }, cancel: asRun };
  }
  if (id.startsWith('memory-')) {
    return { kind: 'memory-keeper', title: `The memory keeper, reading ${about ?? 'what happened'}`, opens: { kind: 'temporal', id }, cancel: asRun };
  }
  const build = afterPrefix(id, 'workspace-build-');
  if (build) {
    const treeId = records.trees.find((entry) => build.startsWith(`${entry.id}-`))?.id;
    const name = treeId ? records.trees.find((entry) => entry.id === treeId)?.name : undefined;
    return { kind: 'workspace-build', title: `Building the workspace${name ? ` of ${name}` : ''}`, opens: treeId ? { kind: 'tree', id: treeId } : { kind: 'temporal', id }, cancel: asRun };
  }
  if (id.startsWith('mcp-capture-')) return { kind: 'run', title: 'Capturing an MCP server\'s tools', opens: { kind: 'temporal', id }, cancel: asRun };
  const conversation = text(workflow.memo?.conversation);
  if (conversation) {
    const title = records.conversations.find((entry) => entry.id === conversation)?.title;
    return { kind: 'chat', title: `${named ?? 'An agent'} answering in "${title || 'a conversation'}"`, opens: { kind: 'chat', id: conversation }, cancel: asRun };
  }
  return { kind: 'run', title: about ? `${named ?? 'An agent'}, working on ${about}` : `${named ?? 'An agent'} at work`, opens: { kind: 'temporal', id }, cancel: asRun };
}

function checkRun(workflow: RunningWorkflow, records: RunningRecords): Omit<RunningItem, 'workflowId' | 'since'> {
  const id = afterPrefix(workflow.workflowId, 'check-run-') ?? workflow.workflowId;
  const run = records.checkRuns.find((entry) => entry.id === id);
  const done = run?.scenarios ? `: ${run.finished ?? 0} of ${count(run.scenarios.length, 'check')}` : '';
  const bench = run?.trigger?.kind !== undefined && run.trigger.kind !== 'manual';
  const agents = run?.trigger?.agents?.length ? run.trigger.agents.map((slug) => records.agentName(slug) ?? slug).join(', ') : undefined;
  return {
    kind: bench ? 'bench' : 'check',
    title: bench ? `The bench, checking ${agents ?? 'everything'}${done}` : `Checks you started${done}`,
    opens: { kind: 'checks', id },
    cancel: { via: 'check', id },
  };
}

const BY_TYPE: Record<string, (workflow: RunningWorkflow, records: RunningRecords) => Omit<RunningItem, 'workflowId' | 'since'>> = {
  AgentRunWorkflow: agentRun,
  CheckRunWorkflow: checkRun,
  AdoptPlanWorkflow: () => ({ kind: 'plan', title: 'Applying a plan you approved', opens: { kind: 'temporal' }, cancel: { via: 'none', why: 'an approved plan is applied in one go, in moments' } }),
  RemoveProjectWorkflow: (workflow, records) => {
    const id = afterPrefix(workflow.workflowId, 'remove-project-');
    const name = id ? records.projects.find((entry) => entry.id === id)?.name : undefined;
    return { kind: 'removal', title: `Deleting the project${name ? ` ${name}` : ''}`, opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'none', why: 'deleting cannot be stopped part way' } };
  },
  RemoveAccountWorkflow: (workflow) => ({
    kind: 'removal',
    title: workflow.workflowId.startsWith('remove-account-space-') ? 'Clearing away a check\'s space' : 'Deleting an account',
    opens: { kind: 'temporal', id: workflow.workflowId },
    cancel: { via: 'none', why: 'removing cannot be stopped part way' },
  }),
  ConcludeWorkspaceWorkflow: (workflow) => ({ kind: 'save', title: 'Saving a workspace\'s files', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'none', why: 'it saves what the workspace holds, then ends' } }),
  executePipelineRunWorkflow: (workflow) => ({ kind: 'deploy', title: 'Building a project', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'workflow' } }),
  executeAppDeployWorkflow: (workflow) => ({ kind: 'deploy', title: 'Deploying an app', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'workflow' } }),
  executeDestroyAppWorkflow: (workflow) => ({ kind: 'deploy', title: 'Removing an app', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'none', why: 'an app being removed is removed to the end' } }),
  executeResizeDiskWorkflow: (workflow) => ({ kind: 'deploy', title: 'Resizing an app\'s disk', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'none', why: 'a disk being resized is resized to the end' } }),
  executeSyncConfigWorkflow: (workflow) => ({ kind: 'deploy', title: 'Updating an app\'s settings', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'workflow' } }),
  executeIngestWorkflow: (workflow) => ({ kind: 'run', title: 'Reading sources into the corpus', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'workflow' } }),
  ClusterProvisionWorkflow: (workflow) => ({ kind: 'deploy', title: 'Making a cluster', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'workflow' } }),
  executeDestroyClusterWorkflow: (workflow) => ({ kind: 'deploy', title: 'Removing a cluster', opens: { kind: 'temporal', id: workflow.workflowId }, cancel: { via: 'none', why: 'a cluster being removed is removed to the end' } }),
};

export function runningItems(workflows: readonly RunningWorkflow[], records: RunningRecords): RunningItem[] {
  return workflows
    .filter((workflow) => !workflow.parent && !HIDDEN_TYPES.includes(workflow.type))
    .map((workflow) => {
      const described = BY_TYPE[workflow.type]?.(workflow, records)
        ?? { kind: 'other' as const, title: `${workflow.type} (${workflow.workflowId})`, opens: { kind: 'temporal' as const, id: workflow.workflowId }, cancel: { via: 'workflow' as const } };
      return { workflowId: workflow.workflowId, since: workflow.startedAt, ...described };
    })
    .sort((a, b) => b.since.localeCompare(a.since));
}
