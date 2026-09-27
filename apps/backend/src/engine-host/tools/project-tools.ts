import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { ActionKind, ActionProposal } from '../../lib/action-proposals.js';
import { envChanges, parseEnv, pickStrategy, sameAction } from '../../lib/action-proposals.js';
import { deploymentForProject, rollupProjectStatus } from '../../lib/project-status.js';
import type { ClusterMetadata, DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from '../../lib/types.js';
import { projectFor, type ProjectScopeStores } from './project-scope.js';

export interface ProjectToolStores extends ProjectScopeStores {
  runs(): Promise<PipelineRunMetadata[]>;
  deployments(): Promise<DeploymentMetadata[]>;
  clusters(ownerId: string): Promise<ClusterMetadata[]>;
  appTypes(ownerId: string): Promise<{ id: string; label?: string | undefined; strategies?: readonly string[] | undefined }[]>;
  readPath(project: ProjectMetadata, path: string): Promise<unknown>;
  bindingCheck(ownerId: string, service: string, as?: string): Promise<{ name: string; type: string } | { problem: string }>;
  proposals: {
    list(ownerId: string): Promise<ActionProposal[]>;
    save(proposal: ActionProposal): Promise<void>;
  };
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const answer = (digest: string, content: string): ToolOutcome => ({ ok: true, digest, content });

const DEPLOYMENT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/i;

export function createProjectTools(options: {
  stores: ProjectToolStores;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}): Record<string, ToolHandler> {
  const { stores } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;

  const scoped = (ownerId: string, parsed: Record<string, unknown>, caller: { projectId?: string | undefined; conversationId?: string | undefined }) =>
    projectFor(stores, ownerId, asString(parsed, 'projectId') ?? asString(parsed, 'project'), caller);

  const succeededRuns = async (project: ProjectMetadata) => (await stores.runs())
    .filter((run) => run.projectId === project.id && run.status === 'succeeded' && Boolean(run.imageTag))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  const propose = async (
    caller: { ownerId?: string | undefined; conversationId?: string | undefined; runId?: string | undefined },
    kind: ActionKind,
    params: Record<string, string>,
    summary: string,
    detail: string[],
    treeId?: string,
  ): Promise<ToolOutcome> => {
    const ownerId = caller.ownerId!;
    const open = (await stores.proposals.list(ownerId)).find((entry) => entry.status === 'proposed' && sameAction(entry, kind, params));
    if (open) return answer(`already proposed: ${open.summary}`, `This is already waiting for the person on a card (${open.summary}); nothing new was proposed.`);

    const stamp = now();
    const proposal: ActionProposal = {
      id: newId(),
      ownerId,
      kind,
      summary,
      detail,
      params,
      status: 'proposed',
      ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
      ...(treeId ? { treeId } : {}),
      ...(caller.runId ? { runId: caller.runId } : {}),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await stores.proposals.save(proposal);
    return answer(`proposed: ${summary}`, `Proposed on a card for the person: ${summary}. Nothing happens until they apply it.`);
  };

  return {
    async get_project_pipeline({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose projects to read');
      const found = await scoped(caller.ownerId, parsed, caller);
      if ('problem' in found) return refuse(found.problem);
      const { project } = found;
      const [runs, deployments] = await Promise.all([stores.runs(), stores.deployments()]);
      const status = rollupProjectStatus(project, runs, deploymentForProject(project, deployments));
      const mine = runs.filter((run) => run.projectId === project.id).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      const latest = mine[0];
      const lines = [
        `${project.name}: ${status.status}${status.reason ? ` — ${status.reason}` : ''}`,
        `repo ${project.giteaOwner ?? '?'}/${project.giteaRepo ?? '?'}, deploys to ${project.targetClusterId ?? 'no cluster yet'}${project.autoDeployOnBuild ? ', automatically after each build' : ''}`,
        latest
          ? `latest build ${latest.id}: ${latest.status}, ${latest.ref ?? ''} ${latest.commitSha?.slice(0, 8) ?? ''}${latest.imageTag ? `, image ${latest.imageTag}` : ''}${latest.errorMessage ? ` — ${latest.errorMessage}` : ''}`
          : 'no builds yet',
        `${mine.length} builds in all`,
      ];
      return answer(`${project.name}: ${status.status}`, lines.join('\n'));
    },

    async get_project_url({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose projects to read');
      const found = await scoped(caller.ownerId, parsed, caller);
      if ('problem' in found) return refuse(found.problem);
      const deployment = deploymentForProject(found.project, await stores.deployments());
      if (!deployment) return answer(`${found.project.name}: not deployed`, `${found.project.name} is not deployed yet.`);
      const url = deployment.displayUrl ?? deployment.url;
      return answer(
        `${found.project.name}: ${deployment.status}`,
        `${found.project.name} runs as ${deployment.name} on ${deployment.clusterId}, ${deployment.status}${deployment.healthReason ? ` — ${deployment.healthReason}` : ''}. ${url ? `It is reached at ${url}.` : 'It has no address yet.'}`,
      );
    },

    async get_project_env({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose projects to read');
      const found = await scoped(caller.ownerId, parsed, caller);
      if ('problem' in found) return refuse(found.problem);
      const env = parseEnv(found.project.deployEnv);
      if (env.size === 0) return answer(`${found.project.name}: no environment`, `${found.project.name} sets no environment variables of its own. Secrets are separate — list_project_secrets.`);
      return answer(
        `${found.project.name}: ${env.size} variables`,
        `Environment variables ${found.project.name} is deployed with (not secrets — those live in the vault):\n${[...env.entries()].map(([key, value]) => `${key}=${value}`).join('\n')}`,
      );
    },

    async read_project_path({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose projects to read');
      const found = await scoped(caller.ownerId, parsed, caller);
      if ('problem' in found) return refuse(found.problem);
      const path = asString(parsed, 'path') ?? '';
      try {
        const result = await stores.readPath(found.project, path);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
        return answer(`${found.project.name}:/${path}`, text.length > 20_000 ? `${text.slice(0, 20_000)}\n…[truncated]` : text);
      } catch (err) {
        return refuse(`could not read ${path || 'the repository root'}: ${(err as Error).message}`);
      }
    },

    async propose_deploy_app({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to deploy for');
      const appType = asString(parsed, 'appType');
      const name = asString(parsed, 'name');
      if (!appType || !name) return refuse('say which app to deploy (appType) and what to call it (name)');
      if (!DEPLOYMENT_NAME.test(name)) return refuse(`"${name}" is not a usable name — letters, digits and dashes, up to 41 characters`);

      const types = await stores.appTypes(caller.ownerId);
      const type = types.find((entry) => entry.id === appType);
      if (!type) return refuse(`"${appType}" is not an app that can be deployed here — the catalogue has: ${types.map((entry) => entry.id).join(', ')}`);

      const clusters = await stores.clusters(caller.ownerId);
      const wanted = asString(parsed, 'cluster');
      const cluster = wanted
        ? clusters.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase() || entry.id === wanted)
        : clusters.find((entry) => entry.isSystem);
      if (!cluster) return refuse(wanted ? `you have no cluster called "${wanted}" — yours are: ${clusters.map((entry) => entry.name).join(', ')}` : 'there is no cluster to deploy to');
      if ((await stores.deployments()).some((entry) => entry.name === name)) return refuse(`a deployment called ${name} already exists — pick another name`);

      const strategy = pickStrategy(type.strategies);
      return propose(caller, 'deploy_app', { appType, name, clusterId: cluster.id, strategy }, `deploy ${type.label ?? appType} as ${name} on ${cluster.name}`, [
        `App: ${type.label ?? appType}`,
        `Name: ${name}`,
        `Cluster: ${cluster.name}`,
        `Strategy: ${strategy}`,
      ]);
    },

    async propose_deploy_project({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to deploy for');
      const found = await scoped(caller.ownerId, parsed, caller);
      if ('problem' in found) return refuse(found.problem);
      const { project } = found;
      if (!project.targetClusterId) return refuse(`${project.name} has no cluster to deploy to yet`);
      const runs = await succeededRuns(project);
      const wantedRun = asString(parsed, 'runId');
      const run = wantedRun ? runs.find((entry) => entry.id === wantedRun) : runs[0];
      if (!run?.imageTag) return refuse(`${project.name} has no successful build${wantedRun ? ` called ${wantedRun}` : ''} to deploy — get_project_pipeline says why`);

      return propose(caller, 'deploy_project', { projectId: project.id, runId: run.id }, `deploy ${project.name} from build ${run.id}`, [
        `Project: ${project.name}`,
        `Build: ${run.id}${run.commitSha ? ` (${run.commitSha.slice(0, 8)})` : ''}`,
        `Image: ${run.imageTag}`,
        `Cluster: ${project.targetClusterId}`,
      ], found.treeId);
    },

    async propose_project_env({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to change a project for');
      const found = await scoped(caller.ownerId, parsed, caller);
      if ('problem' in found) return refuse(found.problem);
      const incoming = parsed.env;
      if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
        return refuse('env has to be an object of KEY: value — and never a secret; secrets go through request_secret');
      }
      const change = envChanges(found.project.deployEnv, incoming as Record<string, unknown>);
      if ('problem' in change) return refuse(change.problem);
      return propose(caller, 'set_project_env', { projectId: found.project.id, env: change.merged }, `change ${change.changed.length} environment variable${change.changed.length === 1 ? '' : 's'} of ${found.project.name}`, [
        `Project: ${found.project.name}`,
        ...change.changed,
        'Takes effect on the next deploy.',
      ], found.treeId);
    },

    async propose_project_dependency({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to change a project for');
      const found = await scoped(caller.ownerId, parsed, caller);
      if ('problem' in found) return refuse(found.problem);
      const service = asString(parsed, 'service');
      if (!service) return refuse('name the service the project should be able to use');
      if ((found.project.needs ?? []).some((need) => need.service === service)) {
        return answer(`${found.project.name} already uses ${service}`, `${found.project.name} already depends on ${service}.`);
      }
      const as = asString(parsed, 'as');
      const check = await stores.bindingCheck(caller.ownerId, service, as);
      if ('problem' in check) return refuse(check.problem);
      return propose(caller, 'add_project_dependency', { projectId: found.project.id, service, ...(as ? { as } : {}) }, `let ${found.project.name} use ${service}`, [
        `Project: ${found.project.name}`,
        `Service: ${service} (${check.type})`,
        `Mounted at $SERVICE_BINDING_ROOT/${check.name}/ on the next deploy`,
      ], found.treeId);
    },
  };
}
