import type { WorkspaceDependency } from '@koala/agent-engine';
import { SHIPPED_DEPENDENCIES } from '../../extensions/workspace-dependencies.js';
import { unknownNeeds, unknownNeedsSaid } from '../lib/workspace-dependencies.js';
import { randomUUID } from 'node:crypto';
import type { StartRunRequest, StartedRun } from '../../engine-host/registries/run-starter.js';
import { MCP_CAPTURE_AGENT } from '../../extensions/mcp/personas.js';
import {
  captureRunId, deploymentOf, runsFingerprint, serverNameFrom, serverProblems, serverState,
  type McpServerRecord, type McpServerTemplate, type ServerRuns, type ServerState,
} from '../lib/mcp-servers.js';
import { looksLikeMcp } from '../lib/mcp-registry.js';
import { serviceNameFor, usableServiceName } from '../../infrastructure/index.js';
import type { DeploymentMetadata } from '../../platform/index.js';

export interface McpServerDeps {
  store: {
    list(ownerId: string): Promise<McpServerRecord[]>;
    save(server: McpServerRecord): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
  };
  templates: () => readonly McpServerTemplate[];
  runs: { start(request: StartRunRequest): Promise<StartedRun> };
  finished: (runId: string) => Promise<{ outcome: string; reason?: string | undefined } | undefined>;
  deployments: () => Promise<readonly DeploymentMetadata[]>;
  names: (ownerId: string, deployment: DeploymentMetadata) => Promise<{ treeName?: string | undefined; projectName?: string | undefined; declared?: string | undefined }>;
  grants?: ServerFollowers | undefined;
  notes?: ServerFollowers | undefined;
  dependencies?: ((ownerId: string) => Promise<readonly WorkspaceDependency[]>) | undefined;
  projects?: ((ownerId: string) => Promise<readonly { id: string; name: string }[]>) | undefined;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
}

export interface ServerFollowers {
  renameServer(ownerId: string, from: string, to: string): Promise<number>;
  forgetServer(ownerId: string, name: string): Promise<number>;
}

export interface McpServerView extends McpServerRecord {
  status: ServerState;
  projectsNamed?: { id: string; name: string }[] | undefined;
}

export interface McpCatalogue {
  servers: McpServerView[];
  templates: (McpServerTemplate & { added: boolean })[];
}

export type McpServerInput = {
  name?: unknown;
  summary?: unknown;
  runs?: unknown;
  offer?: unknown;
  omit?: unknown;
  notes?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  projects?: unknown;
};

export type McpServerOutcome =
  | { ok: true; server: McpServerView }
  | { ok: false; status: 400 | 404 | 409; error: string };

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export class McpServerService {
  constructor(private readonly deps: McpServerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async settled(server: McpServerRecord): Promise<McpServerRecord> {
    if (!server.capturing) return server;
    const ended = await this.deps.finished(server.capturing.runId);
    if (!ended) return server;
    const { capturing: _capturing, ...rest } = server;
    const stamp = this.now().toISOString();
    const recorded = server.captured && server.captured.at >= server.capturing.at;
    const settled: McpServerRecord = recorded || (server.failed && server.failed.at >= server.capturing.at)
      ? { ...rest, updatedAt: stamp }
      : { ...rest, failed: { at: stamp, why: `the capture ended ${ended.outcome} without recording anything${ended.reason ? `: ${ended.reason}` : ''}`, fingerprint: runsFingerprint(server.runs) }, updatedAt: stamp };
    await this.deps.store.save(settled);
    return settled;
  }

  private async view(server: McpServerRecord): Promise<McpServerView> {
    const attached = server.projects ?? [];
    const own = attached.length ? await this.deps.projects?.(server.ownerId) ?? [] : [];
    const named = attached.flatMap((id) => { const project = own.find((entry) => entry.id === id); return project ? [{ id, name: project.name }] : []; });
    return { ...server, status: serverState(server), ...(named.length ? { projectsNamed: named } : {}) };
  }

  private async capture(server: McpServerRecord): Promise<McpServerRecord> {
    const at = this.now();
    const runId = captureRunId(server.id, runsFingerprint(server.runs), at.getTime());
    try {
      await this.deps.runs.start({ ownerId: server.ownerId, agentSlug: MCP_CAPTURE_AGENT, message: `Capture ${server.name}.`, inputs: { serverId: server.id }, runId });
    } catch (err) {
      const failed: McpServerRecord = { ...server, failed: { at: at.toISOString(), why: `the capture could not start: ${(err as Error).message}`, fingerprint: runsFingerprint(server.runs) }, updatedAt: at.toISOString() };
      await this.deps.store.save(failed);
      return failed;
    }
    const capturing: McpServerRecord = { ...server, capturing: { runId, at: at.toISOString() }, updatedAt: at.toISOString() };
    await this.deps.store.save(capturing);
    return capturing;
  }

  private async hostedFromDeployments(ownerId: string, known: McpServerRecord[]): Promise<McpServerRecord[]> {
    const deployments = (await this.deps.deployments()).filter((deployment) => deployment.ownerId === ownerId && looksLikeMcp(deployment));
    const added: McpServerRecord[] = [];
    const taken = new Set(known.map((server) => server.name));
    for (const deployment of deployments) {
      if (known.some((server) => deploymentOf(server) === deployment.id)) continue;
      const names = await this.deps.names(ownerId, deployment);
      const name = serverNameFrom(serviceNameFor({
        ...(usableServiceName(names.declared) ? { declared: usableServiceName(names.declared) } : {}),
        ...(names.treeName ? { treeName: names.treeName } : {}),
        ...(names.projectName ? { projectName: names.projectName } : {}),
        deploymentName: deployment.name,
      }), taken);
      taken.add(name);
      const stamp = this.now().toISOString();
      const server: McpServerRecord = {
        id: this.deps.newId?.() ?? randomUUID(),
        ownerId,
        name,
        runs: { where: 'hosted', deploymentId: deployment.id },
        ...(deployment.gitappProjectId ? { from: { projectId: deployment.gitappProjectId } } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      };
      await this.deps.store.save(server);
      added.push(await this.capture(server));
    }
    return added;
  }

  private async withoutGoneDeployments(ownerId: string, servers: McpServerRecord[]): Promise<McpServerRecord[]> {
    const deployments = new Set((await this.deps.deployments()).filter((deployment) => deployment.ownerId === ownerId).map((deployment) => deployment.id));
    const kept: McpServerRecord[] = [];
    for (const server of servers) {
      const deploymentId = deploymentOf(server);
      if (deploymentId && !deployments.has(deploymentId)) {
        await this.deps.store.remove(ownerId, server.id);
        await this.deps.grants?.forgetServer(ownerId, server.name);
        await this.deps.notes?.forgetServer(ownerId, server.name);
      } else kept.push(server);
    }
    return kept;
  }

  private async capturedOnceListed(servers: McpServerRecord[]): Promise<McpServerRecord[]> {
    return Promise.all(servers.map((server) => (deploymentOf(server) && serverState(server).state === 'new' ? this.capture(server) : server)));
  }

  async catalogue(ownerId: string): Promise<McpCatalogue> {
    const stored = await this.capturedOnceListed(await this.withoutGoneDeployments(ownerId, await Promise.all((await this.deps.store.list(ownerId)).map((server) => this.settled(server)))));
    const servers = [...stored, ...(await this.hostedFromDeployments(ownerId, stored))].sort((a, b) => a.name.localeCompare(b.name));
    const fromTemplate = new Set(servers.flatMap((server) => (server.from && 'template' in server.from ? [server.from.template] : [])));
    return {
      servers: await Promise.all(servers.map((server) => this.view(server))),
      templates: this.deps.templates().map((template) => ({ ...template, added: fromTemplate.has(template.id) })),
    };
  }

  async get(ownerId: string, id: string): Promise<McpServerView | undefined> {
    const found = (await this.deps.store.list(ownerId)).find((server) => server.id === id);
    return found ? await this.view(await this.settled(found)) : undefined;
  }

  private shaped(input: McpServerInput, base: Partial<McpServerRecord>): Omit<McpServerRecord, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'> {
    const has = (key: keyof McpServerInput) => Object.prototype.hasOwnProperty.call(input, key);
    const pick = <K extends keyof McpServerRecord>(key: K & keyof McpServerInput, value: unknown): Partial<McpServerRecord> =>
      (has(key) ? (value === undefined || value === null ? {} : { [key]: value }) : (base[key] !== undefined ? { [key]: base[key] } : {}));
    return {
      name: (has('name') ? input.name : base.name) as string,
      runs: (has('runs') ? input.runs : base.runs) as ServerRuns,
      ...pick('summary', text(input.summary)),
      ...pick('offer', input.offer),
      ...pick('omit', input.omit),
      ...pick('notes', text(input.notes)),
      ...pick('dependsOn', text(input.dependsOn)),
      ...pick('tools', input.tools),
      ...pick('projects', input.projects),
      ...(base.captured ? { captured: base.captured } : {}),
      ...(base.failed ? { failed: base.failed } : {}),
      ...(base.capturing ? { capturing: base.capturing } : {}),
      ...(base.from ? { from: base.from } : {}),
    };
  }

  async add(ownerId: string, input: McpServerInput & { template?: unknown }): Promise<McpServerOutcome> {
    const existing = await this.deps.store.list(ownerId);
    let seed: McpServerInput = input;
    let from: McpServerRecord['from'];
    if (input.template !== undefined) {
      const template = this.deps.templates().find((entry) => entry.id === input.template);
      if (!template) return { ok: false, status: 404, error: `there is no known server called "${String(input.template)}"` };
      const taken = new Set(existing.map((server) => server.name));
      const given = (key: keyof McpServerInput) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
      seed = {
        name: input.name ?? serverNameFrom(template.name, taken),
        summary: given('summary') ? input.summary : template.summary,
        runs: template.runs,
        ...(given('offer') ? { offer: input.offer } : { offer: template.offer, omit: given('omit') ? input.omit : template.omit }),
        notes: given('notes') ? input.notes : template.notes,
        ...(given('dependsOn') ? { dependsOn: input.dependsOn } : {}),
        ...(given('projects') ? { projects: input.projects } : {}),
      };
      from = { template: template.id };
    }
    const shaped = this.shaped(seed, {});
    const problems = [...serverProblems(shaped, existing), ...await this.needsProblems(ownerId, shaped.runs), ...await this.projectsProblems(ownerId, shaped.projects)];
    if (problems.length > 0) return { ok: false, status: problems.some((problem) => problem.startsWith('you already have')) ? 409 : 400, error: problems.join('; ') };
    const stamp = this.now().toISOString();
    const server: McpServerRecord = { ...shaped, id: this.deps.newId?.() ?? randomUUID(), ownerId, ...(from ? { from } : {}), createdAt: stamp, updatedAt: stamp };
    await this.deps.store.save(server);
    return { ok: true, server: await this.view(await this.capture(server)) };
  }

  async save(ownerId: string, id: string, input: McpServerInput): Promise<McpServerOutcome> {
    const existing = await this.deps.store.list(ownerId);
    const current = existing.find((server) => server.id === id);
    if (!current) return { ok: false, status: 404, error: 'Server not found' };
    const shaped = this.shaped(input, current);
    const problems = [...serverProblems(shaped, existing, id), ...await this.needsProblems(ownerId, shaped.runs), ...await this.projectsProblems(ownerId, shaped.projects)];
    if (problems.length > 0) return { ok: false, status: problems.some((problem) => problem.startsWith('you already have')) ? 409 : 400, error: problems.join('; ') };
    const saved: McpServerRecord = { ...shaped, id, ownerId, createdAt: current.createdAt, updatedAt: this.now().toISOString() };
    await this.deps.store.save(saved);
    if (saved.name !== current.name) {
      await this.deps.grants?.renameServer(ownerId, current.name, saved.name);
      await this.deps.notes?.renameServer(ownerId, current.name, saved.name);
    }
    const changed = runsFingerprint(saved.runs) !== runsFingerprint(current.runs);
    return { ok: true, server: await this.view(changed ? await this.capture(saved) : saved) };
  }

  private async projectsProblems(ownerId: string, projects: unknown): Promise<string[]> {
    if (projects === undefined) return [];
    if (!Array.isArray(projects) || !projects.every((id) => typeof id === 'string' && id)) return ['projects has to be a list of project ids'];
    const own = new Set((await this.deps.projects?.(ownerId) ?? []).map((project) => project.id));
    const unknown = projects.filter((id: string) => !own.has(id));
    return unknown.length ? [`${unknown.length === 1 ? 'that project is' : 'those projects are'} not one of yours`] : [];
  }

  private async needsProblems(ownerId: string, runs: McpServerRecord['runs']): Promise<string[]> {
    if (runs?.where !== 'workspace' || !Array.isArray(runs.needs)) return [];
    const catalogue = this.deps.dependencies ? await this.deps.dependencies(ownerId) : SHIPPED_DEPENDENCIES;
    const unknown = unknownNeeds(runs.needs, catalogue);
    return unknown.length ? [unknownNeedsSaid(unknown, catalogue)] : [];
  }

  async recapture(ownerId: string, id: string): Promise<McpServerOutcome> {
    const current = (await this.deps.store.list(ownerId)).find((server) => server.id === id);
    if (!current) return { ok: false, status: 404, error: 'Server not found' };
    const settled = await this.settled(current);
    if (settled.capturing) return { ok: false, status: 409, error: `${settled.name} is being captured already` };
    return { ok: true, server: await this.view(await this.capture(settled)) };
  }

  async remove(ownerId: string, id: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
    const current = (await this.deps.store.list(ownerId)).find((server) => server.id === id);
    if (!current) return { ok: false, status: 404, error: 'Server not found' };
    const deploymentId = deploymentOf(current);
    if (deploymentId && (await this.deps.deployments()).some((deployment) => deployment.id === deploymentId && looksLikeMcp(deployment))) {
      return { ok: false, status: 409, error: `${current.name} is one of your running deployments; it leaves the catalogue when the deployment is removed` };
    }
    await this.deps.store.remove(ownerId, id);
    await this.deps.grants?.forgetServer(ownerId, current.name);
    await this.deps.notes?.forgetServer(ownerId, current.name);
    return { ok: true };
  }
}
