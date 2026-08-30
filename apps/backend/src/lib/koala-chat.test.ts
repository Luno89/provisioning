import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedTreeTypes } from './tree-types.js';
import { runKoalaTool, KOALA_TOOL_NAMES, type KoalaToolContext } from './koala-tool-runner.js';
import { KOALA_TOOLS } from './koala-tools.js';
import { titleFrom, enabledForSession, withEnabled, type Conversation } from './conversations.js';
import { buildKoalaPrompt, KOALA_NAME, KOALA_PROMPT } from './koala-persona.js';
import { PACK_SEEDS } from './pack-seeds.js';
import { canRunLeaf } from './persona-scope.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { acceptLeaf } from './accept-leaf.js';
import { seedTools } from './tool-seeds.js';

const server = (over: Partial<any> = {}) => ({
  id: 'd1', name: 'github-mcp', url: 'http://x',
  tools: [{ name: 'get-repo', description: 'Look up a repo.' }],
  ...over,
});

const seeded = async (over: Partial<Conversation> = {}) => {
  const db = new MemoryDB() as any;
  await seedTools(db);
  await db.saveConversation({
    id: 'c1', ownerId: 'u1', title: 'Chat', messages: [],
    createdAt: 'now', updatedAt: 'now', ...over,
  });
  await seedTreeTypes(db);
  return db;
};

const ctx = (db: any, over: Partial<KoalaToolContext> = {}): KoalaToolContext => ({
  db, userId: 'u1', conversationId: 'c1', sessionId: 's1',
  servers: [server()],
  webSearch: async () => ({ hits: [{ title: 't', snippet: 's', url: 'u' }], unavailable: false, answeredBy: 'searxng' as const }),
  fetchWebPage: async () => 'page',
  ...over,
});

const run = async (db: any, name: string, args: unknown = {}, over: Partial<KoalaToolContext> = {}) => {
  const out = await runKoalaTool(ctx(db, over), { name, arguments: JSON.stringify(args) });
  return { ...out, body: JSON.parse(out.content) };
};

describe('the tools Koala gets', () => {
  const names = KOALA_TOOLS.map((t) => t.function.name);

  it('cannot act on a branch, because there is not one', () => {
    for (const branchTool of ['propose_leaf', 'set_acceptance', 'revise_leaf', 'set_leaf_project']) {
      expect(names, branchTool).not.toContain(branchTool);
    }
    expect(LEAF_TOOLS.map((t) => t.function.name)).toContain('propose_leaf');
  });

  it('proposes projects instead', () => {
    expect(names).toContain('propose_tree');
  });

  it('offers the enable mechanism and says it takes effect immediately', () => {
    const enable = KOALA_TOOLS.find((t) => t.function.name === 'enable_mcp_server')!;
    expect(enable.function.description).toMatch(/IMMEDIATELY/);
    expect(enable.function.description).toMatch(/same reply/);
  });

  it('does not pin the proposed type to a fixed list', () => {
    const params: any = KOALA_TOOLS.find((t) => t.function.name === 'propose_tree')!.function.parameters;
    expect(params.properties.type.enum).toBeUndefined();
    expect(params.properties.type.description).toMatch(/list_tree_types|ids available/i);
  });
});

describe('hooking up a service', () => {
  it('enables it and reports the tools it unlocked', async () => {
    const db = await seeded();
    const out = await run(db, 'enable_mcp_server', { name: 'github-mcp' });
    expect(out.enabled).toBe('github-mcp');
    expect(out.body.tools).toEqual([{ name: 'get-repo', description: 'Look up a repo.' }]);
  });

  it('records it against the session', async () => {
    const db = await seeded();
    await run(db, 'enable_mcp_server', { name: 'github-mcp' });
    const saved = (await db.getConversations())[0];
    expect(enabledForSession(saved, 's1')).toEqual(['github-mcp']);
  });

  it('REFUSES a service that is deployed but not answering', async () => {
    const db = await seeded();
    const out = await run(db, 'enable_mcp_server', { name: 'github-mcp' }, {
      servers: [server({ tools: [], unreachable: 'HTTP 404 from initialize' })],
    });
    expect(out.enabled).toBeUndefined();
    expect(out.body.error).toMatch(/not answering/);
  });

  it('names the real services when asked for one that does not exist', async () => {
    const db = await seeded();
    const out = await run(db, 'enable_mcp_server', { name: 'wether' });
    expect(out.body.error).toMatch(/No service named "wether"/);
    expect(out.body.available).toEqual(['github-mcp']);
  });

  it('is idempotent within a session', async () => {
    const db = await seeded();
    await run(db, 'enable_mcp_server', { name: 'github-mcp' });
    const again = await run(db, 'enable_mcp_server', { name: 'github-mcp' });
    expect(again.enabled).toBe('github-mcp');
    expect(enabledForSession((await db.getConversations())[0], 's1')).toEqual(['github-mcp']);
  });
});

describe('what "session" means', () => {
  it('drops what a previous session enabled', async () => {
    const c = { sessionId: 'old', enabledMcp: ['github-mcp'] } as any;
    expect(enabledForSession(c, 'new')).toEqual([]);
    expect(enabledForSession(c, 'old')).toEqual(['github-mcp']);
  });

  it('drops it when the client names no session at all', () => {
    expect(enabledForSession({ sessionId: 'old', enabledMcp: ['x'] } as any, undefined)).toEqual([]);
  });

  it('starts a fresh list when the session changed, rather than appending', async () => {
    const c: Conversation = {
      id: 'c1', ownerId: 'u1', title: 't', messages: [],
      sessionId: 'old', enabledMcp: ['stale'], createdAt: 'n', updatedAt: 'n',
    };
    expect(withEnabled(c, 'new', 'github-mcp').enabledMcp).toEqual(['github-mcp']);
  });
});

describe('proposing a project', () => {
  it('records it and says plainly that nothing was created', async () => {
    const db = await seeded();
    const out = await run(db, 'propose_tree', { name: 'GitHub API MCP', goal: 'Wrap the GitHub API.', type: 'mcp-server' });
    expect(out.proposed?.name).toBe('GitHub API MCP');
    expect(out.body.note).toMatch(/Nothing is created until the user accepts/);
    expect((await db.getConversations())[0].proposedTrees).toHaveLength(1);
  });

  it('requires a goal, because that is what the planner reads later', async () => {
    const db = await seeded();
    expect((await run(db, 'propose_tree', { name: 'Something' })).body.error).toMatch(/goal is required/);
  });

  it('REFUSES an invented type rather than quietly storing another', async () => {
    const db = await seeded();
    const out = await run(db, 'propose_tree', { name: 'X', goal: 'Y', type: 'not-a-type' });

    expect(out.proposed).toBeUndefined();
    expect(out.content).toMatch(/not-a-type/);
  });
});

describe('ownership', () => {
  it('will not touch another user\'s conversation', async () => {
    const db = await seeded();
    const out = await runKoalaTool(ctx(db, { userId: 'intruder' }), {
      name: 'propose_tree', arguments: JSON.stringify({ name: 'X', goal: 'Y' }),
    });
    expect(JSON.parse(out.content).error).toMatch(/no longer exists/);
  });

  it('takes no owner argument on any dispatchable tool', () => {
    for (const name of KOALA_TOOL_NAMES) {
      const schema = KOALA_TOOLS.find((t) => t.function.name === name);
      const props = Object.keys((schema?.function.parameters as any)?.properties ?? {});
      for (const prop of props) {
        expect(prop, `${name}.${prop}`).not.toMatch(/owner|userId|tenant/i);
      }
    }
  });

  it('offers no tool that takes a command, a script, or a raw request to issue', () => {
    for (const t of KOALA_TOOLS) {
      const props = Object.keys((t.function.parameters as any).properties ?? {});
      for (const prop of props) {
        expect(prop, `${t.function.name}.${prop}`).not.toMatch(/^(command|shell|script|exec|method|body|headers)$/i);
      }
    }
  });
});

describe('every declared tool can be run, and every runnable tool is declared', () => {
  it('has a schema for each dispatchable name', () => {
    for (const name of KOALA_TOOL_NAMES) {
      expect(KOALA_TOOLS.map((t) => t.function.name), name).toContain(name);
    }
  });

  it('has a handler for each declared schema', () => {
    for (const t of KOALA_TOOLS) {
      expect(KOALA_TOOL_NAMES, t.function.name).toContain(t.function.name);
    }
  });

  it('refuses a name it cannot dispatch, rather than pretending', async () => {
    const db = await seeded();
    expect((await run(db, 'call_platform_api', { method: 'DELETE' })).body.error).toMatch(/No tool named/);
  });
});

describe('reaching the web', () => {
  it('searches, now that the tool is actually offered', async () => {
    const db = await seeded();
    const out = await run(db, 'web_search', { query: 'temporal typescript sdk' });
    expect(out.body.results?.[0]?.url).toBe('u');
  });

  it('fetches a page', async () => {
    const db = await seeded();
    expect((await run(db, 'fetch_web_page', { url: 'https://example.com' })).body.text).toBe('page');
  });

  it('still refuses a non-http address', async () => {
    const db = await seeded();
    expect((await run(db, 'fetch_web_page', { url: 'file:///etc/passwd' })).body.error).toMatch(/http or https/);
  });
});

describe('checking arguments before running anything', () => {
  it('names the field when a type is wrong', async () => {
    const db = await seeded();
    expect((await run(db, 'web_search', { query: 42 })).body.error).toMatch(/"query" as string/);
  });

  it('leaves a missing field to the handler, which explains it properly', async () => {
    const db = await seeded();
    expect((await run(db, 'propose_tree', { name: 'X' })).body.error).toMatch(/goal is required/);
  });
});

describe('the prompt Koala is given', () => {
  const servers = [{ name: 'github-mcp', description: 'GitHub API.' }, { name: 'weather' }];

  it('lists names, not tool schemas', () => {
    const prompt = buildKoalaPrompt('BASE', servers, []);
    expect(prompt).toContain('github-mcp');
    expect(prompt).toContain('weather');
    expect(prompt).not.toContain('get-repo');
  });

  it('marks what is already enabled, so it is not enabled twice', () => {
    expect(buildKoalaPrompt('BASE', servers, ['github-mcp'])).toMatch(/github-mcp.*ENABLED/);
  });

  it('says so when there is nothing deployed', () => {
    expect(buildKoalaPrompt('BASE', [], [])).toMatch(/No services are deployed yet/);
  });
});

describe('Koala is chat-only', () => {
  it('seeds with no execution settings at all, which is what makes it chat-only', () => {
    const pack = PACK_SEEDS.find((p) => p.slug === 'koala')!;
    expect(pack.workspace).toBeUndefined();
    expect(canRunLeaf({ tools: [], ...(pack.workspace ? { workspace: pack.workspace } : {}) } as never)).toBe(false);
  });
});

describe('naming a thread', () => {
  it('uses the first thing the user said', () => {
    expect(titleFrom('  help me build a\n  weather service ')).toBe('help me build a weather service');
  });

  it('never returns a blank row', () => {
    expect(titleFrom('')).toBe('New conversation');
    expect(titleFrom('   ')).toBe('New conversation');
  });

  it('truncates rather than storing an essay', () => {
    expect(titleFrom('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe('a leaf must never be assigned to a persona with no environment', () => {
  const leaf = { id: 'l1', ownerId: 'u1', branchId: 'b1', status: 'proposed', packId: 'k1' } as any;
  const withPlan = async () => [{ id: 'b1', acceptance: [{ name: 'runs', command: 'node cli.js' }] } as any];
  const accept = (persona: any) => acceptLeaf(
    { db: { saveLeaf: async () => {}, getBranches: withPlan }, packOf: async () => persona },
    leaf,
    [],
  );

  it('refuses, and says to pick one that builds', async () => {
    const result = await accept({ name: KOALA_NAME, tools: ['propose_tree'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/chat only/);
      expect(result.error).toMatch(/Assign a pack that builds/);
    }
  });

  it('accepts a leaf assigned to one that does build', async () => {
    const result = await accept({
      name: 'Builder',
      tools: ['run_command', 'read_file', 'write_file', 'finish'],
      workspace: { repo: true },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a tool-less reviewer, whose empty toolset is a decision and not an absence', async () => {
    const result = await accept({ name: 'Reviewer', tools: [], workspace: { language: 'base' } });
    expect(result.ok).toBe(true);
  });

  it('still refuses a chat pack that has been renamed', async () => {
    const result = await accept({ name: 'Talky', tools: ['propose_tree'] });
    expect(result.ok).toBe(false);
  });

  it('skips the check when the caller passed no lookup', async () => {
    const result = await acceptLeaf({ db: { saveLeaf: async () => {}, getBranches: withPlan } }, leaf, []);
    expect(result.ok).toBe(true);
  });
});

describe('knowing what the cluster actually has', () => {
  const deployments = [
    { id: 'd1', name: 'koala-vectors', appType: 'qdrant', status: 'running', ownerId: 'u1' },
    { id: 'd2', name: 'koala-store', appType: 'minio', status: 'running', ownerId: 'u1' },
    { id: 'd3', name: 'half-built', appType: 'qdrant', status: 'deploying', ownerId: 'u1' },
    { id: 'd4', name: 'someone-elses', appType: 'minio', status: 'running', ownerId: 'u2' },
  ];

  it('reports the services a build could actually reach', async () => {
    const db = await seeded();
    for (const d of deployments) await db.saveDeployment(d as any);
    const out = await run(db, 'list_infrastructure');
    expect(out.body.running.map((s: any) => s.name)).toEqual(['koala-vectors', 'koala-store']);
  });

  it('leaves out what is not running, and what is not theirs', async () => {
    const db = await seeded();
    for (const d of deployments) await db.saveDeployment(d as any);
    const names = (await run(db, 'list_infrastructure')).body.running.map((s: any) => s.name);
    expect(names).not.toContain('half-built');
    expect(names).not.toContain('someone-elses');
  });

  it('lists what CAN be deployed, and mongo is not among it', async () => {
    const db = await seeded();
    const ids = (await run(db, 'list_infrastructure')).body.deployable.map((d: any) => d.id);
    expect(ids).toContain('qdrant');
    expect(ids).not.toContain('mongo');
    expect(ids).not.toContain('mongodb');
  });

  it('says what each deployable thing IS, not just its id', async () => {
    const db = await seeded();
    const byId = new Map<string, any>(
      (await run(db, 'list_infrastructure')).body.deployable.map((d: any) => [d.id, d]),
    );
    expect(byId.get('qdrant').is).toMatch(/vector database/);
    expect(byId.get('minio').is).toMatch(/object storage/);
    expect(byId.get('tei').is).toMatch(/embedding/);
    expect(byId.get('quickwit').provides).toContain('full-text-search');
  });

  it('describes what is RUNNING too', async () => {
    const db = await seeded();
    for (const d of deployments) await db.saveDeployment(d as any);
    const running = (await run(db, 'list_infrastructure')).body.running;
    expect(running.find((s: any) => s.name === 'koala-vectors').is).toMatch(/vector database/);
    expect(running.find((s: any) => s.name === 'koala-store').provides).toContain('object-storage');
  });

  it('says what an absence MEANS, since a long list hides it', async () => {
    const db = await seeded();
    const out = await run(db, 'list_infrastructure');
    expect(out.body.note).toMatch(/does not exist here and cannot be built/);
    expect(out.body.note).toMatch(/do not invent one/);
  });

  it('invents no connection strings', async () => {
    const db = await seeded();
    for (const d of deployments) await db.saveDeployment(d as any);
    const out = await run(db, 'list_infrastructure');
    expect(JSON.stringify(out.body.running)).not.toMatch(/http|:\d{4}|svc\.cluster\.local/);
  });

  it('is offered as a tool, and the prompt says to call it first', async () => {
    expect(KOALA_TOOLS.map((t) => t.function.name)).toContain('list_infrastructure');
    expect(KOALA_PROMPT).toMatch(/call\s*\n?\s*list_infrastructure|list_infrastructure/);
    expect(KOALA_PROMPT).toMatch(/does not exist here and cannot be built/);
  });
});

describe('proposing a new app type', () => {
  const mongo = {
    id: 'mongo',
    image: 'mongo:7',
    ports: [{ name: 'mongo', port: 27017 }],
    env: [{ name: 'MONGO_INITDB_ROOT_PASSWORD', fromSecret: 'password', generate: 'password' }],
    volumes: [{ path: '/data/db', size: '10Gi' }],
    resources: { limits: { memory: '1Gi', cpu: '1000m' } },
  };

  it('records it and says plainly that nothing is deployable yet', async () => {
    const db = await seeded();
    const out = await run(db, 'propose_spec', mongo);
    expect(out.proposedSpec?.id).toBe('mongo');
    expect(out.body.note).toMatch(/not deployable until the user accepts/);
    expect((await db.getConversations())[0].proposedSpecs).toHaveLength(1);
  });

  it('refuses one that would escape its namespace, in the turn that wrote it', async () => {
    const db = await seeded();
    const out = await run(db, 'propose_spec', { ...mongo, hostPath: '/etc' });
    expect(out.proposedSpec).toBeUndefined();
    expect(out.body.error).toMatch(/may not reach the node/);
    expect((await db.getConversations())[0].proposedSpecs ?? []).toHaveLength(0);
  });

  it('refuses one with no memory limit', async () => {
    const db = await seeded();
    const { resources, ...noLimits } = mongo;
    expect((await run(db, 'propose_spec', noLimits)).body.error).toMatch(/memory limit/);
  });

  it('proposes a REPLACEMENT for one that already exists', async () => {
    const db = await seeded();
    await db.saveAppSpec({ id: 'mongo', spec: mongo as any, builtIn: false, createdAt: 'n', updatedAt: 'n' });
    const out = await run(db, 'propose_spec', { ...mongo, args: [] });
    expect(out.proposedSpec?.replaces).toBe(true);
    expect(out.body.note).toMatch(/keeps running until it is redeployed/);
  });

  it('still refuses to rewrite a BUILT-IN', async () => {
    const db = await seeded();
    await db.saveAppSpec({ id: 'minio', spec: mongo as any, builtIn: true, createdAt: 'n', updatedAt: 'n' });
    expect((await run(db, 'propose_spec', { ...mongo, id: 'minio' })).body.error)
      .toMatch(/ships with the platform/);
  });

  it('is offered, and told never to write a password', async () => {
    const tool = KOALA_TOOLS.find((t) => t.function.name === 'propose_spec')!;
    const env: any = (tool.function.parameters as any).properties.env;
    expect(env.description).toMatch(/Never write a password here/);
    expect((tool.function.parameters as any).required).toContain('resources');
  });
});

describe('knowing that something it built is broken', () => {
  const broken = [
    { id: 'd1', name: 'spec-mongo', appType: 'mongo', status: 'unhealthy', ownerId: 'u1',
      healthReason: 'auth is not allowed when noauth is specified' },
    { id: 'd2', name: 'fine', appType: 'qdrant', status: 'running', ownerId: 'u1' },
    { id: 'd3', name: 'starting', appType: 'minio', status: 'deploying', ownerId: 'u1' },
    { id: 'd4', name: 'theirs', appType: 'mongo', status: 'unhealthy', ownerId: 'u2' },
  ];

  it('reports what is broken, with the reason', async () => {
    const db = await seeded();
    for (const d of broken) await db.saveDeployment(d as any);
    const out = await run(db, 'list_infrastructure');
    expect(out.body.broken).toEqual([
      { name: 'spec-mongo', type: 'mongo', reason: 'auth is not allowed when noauth is specified' },
    ]);
  });

  it('leaves out what is merely still deploying', async () => {
    const db = await seeded();
    for (const d of broken) await db.saveDeployment(d as any);
    const names = (await run(db, 'list_infrastructure')).body.broken.map((b: any) => b.name);
    expect(names).not.toContain('starting');
    expect(names).not.toContain('theirs');
  });

  it('tells Koala to fix the SPEC rather than redeploy it unchanged', async () => {
    const db = await seeded();
    for (const d of broken) await db.saveDeployment(d as any);
    expect((await run(db, 'list_infrastructure')).body.note).toMatch(/propose a corrected one/);
  });

  it('says nothing about broken things when nothing is', async () => {
    const db = await seeded();
    await db.saveDeployment(broken[1] as any);
    const out = await run(db, 'list_infrastructure');
    expect(out.body.broken).toBeUndefined();
    expect(out.body.note).not.toMatch(/propose a corrected one/);
  });

  it('falls back to the status when no reason was recorded', async () => {
    const db = await seeded();
    await db.saveDeployment({ id: 'd9', name: 'x', appType: 'mongo', status: 'failed', ownerId: 'u1' } as any);
    expect((await run(db, 'list_infrastructure')).body.broken[0].reason).toBe('status is failed');
  });
});

describe('Koala can wire up what it discovers', () => {
  it('has the same dependency tool the planners do', () => {
    expect(KOALA_TOOLS.map((t) => t.function.name)).toContain('add_project_dependency');
  });

  it('points at where a projectId comes from, since Koala has no list_projects', () => {
    const tool = KOALA_TOOLS.find((t) => t.function.name === 'add_project_dependency')!;
    expect(tool.function.description).toMatch(/list_mcp_servers or\s*\n?\s*list_trees/);
  });

  it('says plainly that declaring is not deploying', () => {
    const tool = KOALA_TOOLS.find((t) => t.function.name === 'add_project_dependency')!;
    expect(tool.function.description).toMatch(/Nothing is deployed by\s*\n?\s*this/);
  });
});

describe('Project CI/CD and deployment tools', () => {
  it('get_project_pipeline returns project status and latest run', async () => {
    const db = await seeded();
    await db.saveProject({
      id: 'proj-1',
      ownerId: 'u1',
      name: 'metrics-api',
      giteaOwner: 'u1',
      giteaRepo: 'metrics-api',
      targetClusterId: 'cluster-1',
      autoDeployOnBuild: true,
      createdAt: 'now',
    });
    await db.savePipelineRun({
      id: 'run-1',
      projectId: 'proj-1',
      commitSha: 'abcdef123456',
      ref: 'main',
      status: 'succeeded',
      imageTag: 'gitea-registry.gitea.svc.cluster.local:5000/u1/metrics-api:abcdef123456',
      startedAt: '2026-08-26T10:00:00Z',
      finishedAt: '2026-08-26T10:01:00Z',
    });

    const out = await run(db, 'get_project_pipeline', { name: 'metrics-api' });
    expect(out.body.project.name).toBe('metrics-api');
    expect(out.body.project.targetCluster).toBe('cluster-1');
    expect(out.body.project.autoDeployOnBuild).toBe(true);
    expect(out.body.latestRun.commitSha).toBe('abcdef123456');
    expect(out.body.latestRun.status).toBe('succeeded');
  });

  it('deploy_project triggers promotion of built image', async () => {
    const db = await seeded();
    await db.saveProject({
      id: 'proj-1',
      ownerId: 'u1',
      name: 'metrics-api',
      giteaOwner: 'u1',
      giteaRepo: 'metrics-api',
      targetClusterId: 'cluster-1',
      autoDeployOnBuild: true,
      createdAt: 'now',
    });
    await db.savePipelineRun({
      id: 'run-1',
      projectId: 'proj-1',
      commitSha: 'abcdef123456',
      ref: 'main',
      status: 'succeeded',
      imageTag: 'gitea-registry.gitea.svc.cluster.local:5000/u1/metrics-api:abcdef123456',
      startedAt: '2026-08-26T10:00:00Z',
    });

    const mockPromote = async (_proj: any, _run: any, _user: string) => ({ id: 'wf-promote-1', resourceId: 'dep-1' });

    const out = await run(db, 'deploy_project', { name: 'metrics-api' }, {
      temporalBridge: { promoteProjectBuild: mockPromote } as any,
    });
    expect(out.body.status).toBe('deploying');
    expect(out.body.imageTag).toContain('metrics-api:abcdef123456');
    expect(out.body.workflowId).toBe('wf-promote-1');
  });

  it('get_project_url returns reachable url when deployed', async () => {
    const db = await seeded();
    await db.saveProject({
      id: 'proj-1',
      ownerId: 'u1',
      name: 'metrics-api',
      giteaOwner: 'u1',
      giteaRepo: 'metrics-api',
      createdAt: 'now',
    });
    await db.saveDeployment({
      id: 'dep-1',
      ownerId: 'u1',
      name: 'metrics-api',
      appType: 'gitapp',
      gitappProjectId: 'proj-1',
      status: 'running',
      displayUrl: 'http://metrics-api.apps.local',
      clusterId: 'cluster-1',
    });

    const out = await run(db, 'get_project_url', { name: 'metrics-api' });
    expect(out.body.project).toBe('metrics-api');
    expect(out.body.status).toBe('running');
    expect(out.body.url).toBe('http://metrics-api.apps.local');
  });
});
