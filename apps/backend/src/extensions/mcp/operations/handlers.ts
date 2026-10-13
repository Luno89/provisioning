import { egressFor, lifetimeFor, packageAccessFor, type ImagePlan, type RunWorkspace } from '@koala/agent-engine';
import type { NodeRequest, StepResult } from '@koala/agent-engine/procedure';
import type { EnvironmentDriver } from '@koala/engine-core';
import { McpClient, type Fetcher } from '../../../lib/mcp-client.js';
import { runsFingerprint, serverPath, type CapturedServer, type McpServerRecord, type ServerRuns } from '../../../lib/mcp-servers.js';
import { execFetch, startScript } from '../../../engine-host/tools/workspace-servers.js';
import { environmentIdFor } from '../../../engine-host/sandboxes/run-environments.js';
import type { EnvironmentHandleRef, RunTicket } from '../../../engine-host/temporal/contracts.js';
import type { HostOperationRun } from '../../types.js';

export const CAPTURE_CPU = '1';
export const CAPTURE_MEMORY = '2Gi';
const CAPTURE_LIFETIME_MS = 30 * 60_000;

export interface McpOperationDeps {
  servers: {
    get(ownerId: string, id: string): Promise<McpServerRecord | undefined>;
    save(server: McpServerRecord): Promise<void>;
  };
  hostedUrl(ownerId: string, runs: Extract<ServerRuns, { where: 'hosted' }>): Promise<string | undefined>;
  plan(runs: Extract<ServerRuns, { where: 'workspace' }>, name: string): ImagePlan;
  images: { ensure(plan: ImagePlan): Promise<string> };
  environments: {
    forRun(request: { ticket: RunTicket; environment?: EnvironmentHandleRef | undefined }): Promise<EnvironmentDriver | undefined>;
    release(runId: string): Promise<void>;
  };
  fetch?: Fetcher | undefined;
  now?: (() => string) | undefined;
}

interface OpenedServer {
  id: string;
  name: string;
  runs: ServerRuns;
  fingerprint: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const ownerOf = (request: NodeRequest): string => request.run.launch.ownerId;

function serverFrom(request: NodeRequest): OpenedServer {
  const server = request.inputs.server;
  if (!isRecord(server) || typeof server.id !== 'string' || !isRecord(server.runs) || typeof server.fingerprint !== 'string') {
    throw new Error('this needs the server, as Open Server hands it on');
  }
  return server as unknown as OpenedServer;
}

const ticketOf = (request: NodeRequest): RunTicket => ({
  runId: request.run.identity.runId,
  depth: request.run.identity.depth,
  ownerId: ownerOf(request),
  agentSlug: request.run.identity.agentId,
  trigger: request.run.identity.trigger,
});

async function ask(client: McpClient, at: string, fingerprint: string): Promise<CapturedServer> {
  const session = await client.initialize();
  const tools = (await client.listTools()).filter((tool) => typeof tool?.name === 'string' && tool.name);
  return {
    ...(session.instructions ? { instructions: session.instructions } : {}),
    ...(session.serverName || session.serverVersion ? { serverInfo: { ...(session.serverName ? { name: session.serverName } : {}), ...(session.serverVersion ? { version: session.serverVersion } : {}) } } : {}),
    tools,
    at,
    fingerprint,
  };
}

export function captureWorkspace(ticket: RunTicket, image: string, provides: readonly string[]): RunWorkspace {
  const access = packageAccessFor(provides);
  return {
    runId: ticket.runId,
    ownerId: ticket.ownerId,
    agent: ticket.agentSlug,
    image,
    provides: [...provides],
    lifetimeMs: lifetimeFor(CAPTURE_LIFETIME_MS),
    cpu: CAPTURE_CPU,
    memory: CAPTURE_MEMORY,
    egress: egressFor('declared', access),
    env: access.env,
    egressMode: 'declared',
  };
}

export function createMcpOperations(deps: McpOperationDeps): Record<string, HostOperationRun> {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async 'mcp.open'(request): Promise<StepResult> {
      const wired = request.inputs.serverId;
      const started = request.run.inputs.serverId;
      const id = typeof wired === 'string' && wired ? wired : typeof started === 'string' && started ? started : undefined;
      if (!id) return { exit: 'missing', outputs: { reason: 'no serverId was wired in, and the run was not started with one' } };
      const found = await deps.servers.get(ownerOf(request), id);
      if (!found) return { exit: 'missing', outputs: { reason: `there is no server "${id}"` } };
      const server: OpenedServer = { id: found.id, name: found.name, runs: found.runs, fingerprint: runsFingerprint(found.runs) };
      return { exit: found.runs.where, outputs: { server } };
    },

    async 'mcp.connect'(request): Promise<StepResult> {
      const server = serverFrom(request);
      if (server.runs.where !== 'hosted') throw new Error(`${server.name} runs in a workspace, so it is started there, not connected to`);
      const url = await deps.hostedUrl(ownerOf(request), server.runs);
      if (!url) return { exit: 'failed', outputs: { reason: `${server.name} has no address this server can reach: its deployment is not running, or nothing routes to it` } };
      try {
        return { exit: 'captured', outputs: { captured: await ask(new McpClient(url, deps.fetch ?? fetch), now(), server.fingerprint) } };
      } catch (err) {
        return { exit: 'failed', outputs: { reason: `${server.name} did not answer at ${url}: ${(err as Error).message}` } };
      }
    },

    async 'mcp.build'(request): Promise<StepResult> {
      const server = serverFrom(request);
      if (server.runs.where !== 'workspace') throw new Error(`${server.name} is hosted, so there is nothing to build`);
      let plan: ImagePlan;
      try {
        plan = deps.plan(server.runs, server.name);
      } catch (err) {
        return { exit: 'failed', outputs: { reason: (err as Error).message } };
      }
      try {
        return { exit: 'built', outputs: { image: await deps.images.ensure(plan) } };
      } catch (err) {
        return { exit: 'failed', outputs: { reason: `its image did not build: ${(err as Error).message}` } };
      }
    },

    async 'mcp.start'(request): Promise<StepResult> {
      const server = serverFrom(request);
      if (server.runs.where !== 'workspace') throw new Error(`${server.name} is hosted, so it is not started here`);
      const image = request.inputs.image;
      if (typeof image !== 'string' || !image) throw new Error('this needs the image Build Server Image built');
      const ticket = ticketOf(request);
      const runs = server.runs;
      const driver = await deps.environments.forRun({
        ticket,
        environment: {
          id: environmentIdFor(ticket.runId),
          spec: { kind: 'sandbox', lifecycle: 'invocation' },
          workspace: captureWorkspace(ticket, image, deps.plan(runs, server.name).provides),
        },
      });
      if (!driver) return { exit: 'failed', outputs: { reason: 'no sandbox could be started to run it in' } };
      const started = await driver.exec({ command: startScript(server.name, { start: runs.start, port: runs.port, path: serverPath(runs) }), untimed: true });
      if (started.exitCode !== 0) return { exit: 'failed', outputs: { reason: `${server.name} did not start: ${(started.stdout + started.stderr).trim() || `it exited ${started.exitCode}`}` } };
      try {
        const client = new McpClient(`http://127.0.0.1:${runs.port}${serverPath(runs)}`, execFetch(driver), 0);
        return { exit: 'captured', outputs: { captured: await ask(client, now(), server.fingerprint) } };
      } catch (err) {
        return { exit: 'failed', outputs: { reason: `${server.name} started but did not answer as an MCP server: ${(err as Error).message}` } };
      }
    },

    async 'mcp.release'(request): Promise<StepResult> {
      await deps.environments.release(request.run.identity.runId);
      return { exit: 'done', outputs: {} };
    },

    async 'mcp.record'(request): Promise<StepResult> {
      const server = serverFrom(request);
      const ownerId = ownerOf(request);
      const current = await deps.servers.get(ownerId, server.id);
      if (!current) return { exit: 'recorded', outputs: { summary: `${server.name} was removed while it was captured, so nothing was kept` } };
      const { capturing, failed, ...rest } = current;
      const kept = capturing && capturing.runId !== request.run.identity.runId ? { capturing } : {};
      const stamp = now();
      if (request.node.settings.what === 'captured') {
        const captured = request.inputs.captured;
        if (!isRecord(captured) || !Array.isArray(captured.tools)) throw new Error('this needs what the server said, as the capture hands it on');
        const said = captured as unknown as CapturedServer;
        await deps.servers.save({ ...rest, ...kept, captured: said, updatedAt: stamp });
        return { exit: 'recorded', outputs: { summary: `${server.name} serves ${said.tools.length} tool${said.tools.length === 1 ? '' : 's'}` } };
      }
      const reason = typeof request.inputs.reason === 'string' && request.inputs.reason ? request.inputs.reason : 'the capture failed and said nothing about why';
      await deps.servers.save({ ...rest, ...kept, failed: { at: stamp, why: reason, fingerprint: server.fingerprint }, updatedAt: stamp });
      return { exit: 'recorded', outputs: { summary: `${server.name} could not be captured: ${reason}` } };
    },
  };
}
