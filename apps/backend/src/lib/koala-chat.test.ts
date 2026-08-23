import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedTreeTypes } from './tree-types.js';
import { runKoalaTool, KOALA_TOOL_NAMES, type KoalaToolContext } from './koala-tool-runner.js';
import { KOALA_TOOLS } from './koala-tools.js';
import { titleFrom, enabledForSession, withEnabled, type Conversation } from './conversations.js';
import { buildKoalaPrompt, isChatOnly, koalaSeed, KOALA_NAME, KOALA_PROMPT } from './koala-persona.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { acceptLeaf } from './accept-leaf.js';

/**
 * General chat with Koala.
 *
 * ── WHAT MAKES IT DIFFERENT FROM A BRANCH ──
 * A branch is a conversation about building one thing, and everything it produces is work someone
 * accepts and runs. Asking "what is going on with the MCP server" should not require choosing a tree
 * first, nor leave a branch behind. So this is a normal chat whose output is a proposed PROJECT.
 *
 * ── AND THE LAZY TOOL MECHANISM ──
 * Every deployed service's tool schemas riding on every message would cost thousands of tokens per
 * turn for capabilities the conversation is usually not about. Names go in the prompt (~10 tokens);
 * `enable_mcp_server` loads the rest, and must take effect in the SAME turn or the mechanism does
 * not work.
 */

const server = (over: Partial<any> = {}) => ({
  id: 'd1', name: 'github-mcp', url: 'http://x',
  tools: [{ name: 'get-repo', description: 'Look up a repo.' }],
  ...over,
});

const seeded = async (over: Partial<Conversation> = {}) => {
  const db = new MemoryDB() as any;
  await db.saveConversation({
    id: 'c1', ownerId: 'u1', title: 'Chat', messages: [],
    createdAt: 'now', updatedAt: 'now', ...over,
  });
  // Project types are owned records now, so a fixture without them cannot propose anything — the
  // handler resolves the type against the caller's own list.
  await seedTreeTypes(db, 'u1');
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
    /**
     * Offering LEAF_TOOLS here would let Koala propose work into a board that does not exist, and
     * the failure would be "no such branch" for reasons the model cannot understand.
     */
    for (const branchTool of ['propose_leaf', 'set_acceptance', 'revise_leaf', 'set_leaf_project']) {
      expect(names, branchTool).not.toContain(branchTool);
    }
    expect(LEAF_TOOLS.map((t) => t.function.name)).toContain('propose_leaf');
  });

  it('proposes projects instead', () => {
    expect(names).toContain('propose_tree');
  });

  it('offers the enable mechanism and says it takes effect immediately', () => {
    // If the model believes it must wait for the next message, it will stop and ask.
    const enable = KOALA_TOOLS.find((t) => t.function.name === 'enable_mcp_server')!;
    expect(enable.function.description).toMatch(/IMMEDIATELY/);
    expect(enable.function.description).toMatch(/same reply/);
  });

  it('does not pin the proposed type to a fixed list', () => {
    /**
     * This asserted an enum, built from a module constant. Project types are owned records now, so a
     * schema built once at import cannot know a type added this morning — and a fixed list would
     * quietly exclude it. The handler validates against the caller's own types instead and refuses
     * with the valid ids, which is the division `validateArgs` sets out.
     */
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
    /**
     * Enabling it would hand the model tools whose every call fails, and it would spend the rest of
     * the conversation reasoning about errors with one cause it cannot see.
     */
    const db = await seeded();
    const out = await run(db, 'enable_mcp_server', { name: 'github-mcp' }, {
      servers: [server({ tools: [], unreachable: 'HTTP 404 from initialize' })],
    });
    expect(out.enabled).toBeUndefined();
    expect(out.body.error).toMatch(/not answering/);
  });

  it('names the real services when asked for one that does not exist', async () => {
    // A model that guessed will otherwise guess again.
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
    /**
     * The reset the session boundary exists for: a tool enabled three weeks ago, in a conversation
     * about something else, should not still ride on every message.
     */
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
    // A type is required now rather than defaulted — it decides the image, the starter files and
    // what finishing means, so it is not a field to guess. See propose-tree-type.test.ts.
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
    /**
     * This used to assert a fallback to `TREE_TYPES[0]` — an MCP server. The type decides the
     * workspace image, the starter files and what finishing means, so substituting one silently
     * builds a different kind of project than was asked for, and nothing says so.
     */
    const db = await seeded();
    const out = await run(db, 'propose_tree', { name: 'X', goal: 'Y', type: 'not-a-type' });

    expect(out.proposed).toBeUndefined();
    // The refusal is in the tool RESULT the model reads, not on the helper's typed shape.
    expect(out.content).toMatch(/not-a-type/);
  });
});

describe('ownership', () => {
  it('will not touch another user\'s conversation', async () => {
    // The id comes from the session; a tool argument could otherwise name anyone's thread.
    const db = await seeded();
    const out = await runKoalaTool(ctx(db, { userId: 'intruder' }), {
      name: 'propose_tree', arguments: JSON.stringify({ name: 'X', goal: 'Y' }),
    });
    expect(JSON.parse(out.content).error).toMatch(/no longer exists/);
  });

  /**
   * Widened from KOALA_TOOLS to the dispatch table, so it covers what can be RUN rather than what
   * happens to be declared. Ownership arrives on `ctx` from the session the route authenticated;
   * an argument is a value the model chose, and the two must never be confusable.
   */
  it('takes no owner argument on any dispatchable tool', () => {
    for (const name of KOALA_TOOL_NAMES) {
      const schema = KOALA_TOOLS.find((t) => t.function.name === name);
      const props = Object.keys((schema?.function.parameters as any)?.properties ?? {});
      for (const prop of props) {
        expect(prop, `${name}.${prop}`).not.toMatch(/owner|userId|tenant/i);
      }
    }
  });

  /**
   * `get_logs` and `get_events` build kubectl invocations as ARGUMENT ARRAYS this codebase
   * constructs — never a string a model wrote. A tool that took a command, a script or a URL
   * template would hand that back, so the shape is asserted rather than remembered.
   *
   * The abandoned harness-v2 branch is the cautionary case: its `call_platform_api` took a method
   * and a path and issued any authenticated request the model asked for, DELETE included.
   */
  it('offers no tool that takes a command, a script, or a raw request to issue', () => {
    for (const t of KOALA_TOOLS) {
      const props = Object.keys((t.function.parameters as any).properties ?? {});
      for (const prop of props) {
        expect(prop, `${t.function.name}.${prop}`).not.toMatch(/^(command|shell|script|exec|method|body|headers)$/i);
      }
    }
  });
});

/**
 * ── THE BUG THIS SECTION EXISTS FOR ──
 * `web_search` and `fetch_web_page` had working handlers, and the chat route wired the live
 * implementations into their context, and a dead `KOALA_TOOL_NAMES` constant listed them — but
 * neither had a schema in KOALA_TOOLS, so no model was ever told they existed. Koala could not
 * search the web, and every piece of the machinery said it could.
 *
 * The join in koala-tools.ts now makes that combination a compile error. These assert it stays one.
 */
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
    // The handler's own rule, unchanged by the move — file:// and friends are not fetchable here.
    const db = await seeded();
    expect((await run(db, 'fetch_web_page', { url: 'file:///etc/passwd' })).body.error).toMatch(/http or https/);
  });
});

describe('checking arguments before running anything', () => {
  it('names the field when a type is wrong', async () => {
    const db = await seeded();
    expect((await run(db, 'web_search', { query: 42 })).body.error).toMatch(/"query" as string/);
  });

  /**
   * Deliberately NOT enforced here: the handlers report a missing field far better, because they
   * know what it is for. Asserted so nobody re-adds a generic required-key check on top of them.
   */
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
    // A model that cannot see a service it holds tools for will spend a round re-enabling it.
    expect(buildKoalaPrompt('BASE', servers, ['github-mcp'])).toMatch(/github-mcp.*ENABLED/);
  });

  it('says so when there is nothing deployed', () => {
    expect(buildKoalaPrompt('BASE', [], [])).toMatch(/No services are deployed yet/);
  });
});

describe('Koala is chat-only', () => {
  it('is recognised by name, which survives the user editing it', () => {
    expect(isChatOnly({ name: KOALA_NAME })).toBe(true);
    expect(isChatOnly({ name: 'koala' })).toBe(true);
    expect(isChatOnly({ name: 'Builder' })).toBe(false);
    expect(isChatOnly(null)).toBe(false);
  });

  it('seeds with no execution settings at all', () => {
    // language, repo and egress are execution settings, and "anything" is not a toolchain.
    const seed: any = koalaSeed();
    expect(seed.scope).toEqual({});
    expect(seed.name).toBe(KOALA_NAME);
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


describe('a leaf must never be assigned to Koala', () => {
  /**
   * Same failure as a leaf with no persona at all — an environment nobody chose — arriving by a
   * route that looks assigned. Ten minutes into a sandbox is a bad place to discover it.
   */
  const leaf = { id: 'l1', ownerId: 'u1', branchId: 'b1', status: 'proposed', personaId: 'k1' } as any;
  const withPlan = async () => [{ id: 'b1', acceptance: [{ name: 'runs', command: 'node cli.js' }] } as any];

  it('refuses, and says to pick one that builds', async () => {
    const result = await acceptLeaf(
      {
        db: { saveLeaf: async () => {}, getBranches: withPlan },
        personaOf: async () => ({ name: KOALA_NAME }),
      },
      leaf,
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/chat only/);
      expect(result.error).toMatch(/Assign a persona that builds/);
    }
  });

  it('accepts a leaf assigned to one that does build', async () => {
    const result = await acceptLeaf(
      {
        db: { saveLeaf: async () => {}, getBranches: withPlan },
        personaOf: async () => ({ name: 'Builder' }),
      },
      leaf,
      [],
    );
    expect(result.ok).toBe(true);
  });

  it('skips the check when the caller passed no lookup', async () => {
    // Optional so existing callers keep working; absent must not fail acceptance over a dependency
    // somebody did not pass.
    const result = await acceptLeaf({ db: { saveLeaf: async () => {}, getBranches: withPlan } }, leaf, []);
    expect(result.ok).toBe(true);
  });
});

describe('knowing what the cluster actually has', () => {
  /**
   * ── THE GAP ──
   * Asked to add MongoDB caching to the GitHub MCP server, Koala planned it. There is no MongoDB:
   * `mongo` is not in APP_TYPES, so the platform cannot deploy one, and the instance's own runs
   * under docker-compose — not in the cluster, not reachable by a built service.
   *
   * Koala had no way to know. `list_mcp_servers` shows only gitapp deployments that speak MCP, so
   * the eight other services actually running were invisible too. It could neither use what was
   * there nor say that what was asked for was not.
   */
  /**
   * Ids matter here, and not only for realism: MemoryDB saves with
   * `findIndex(d => d.id === deployment.id)`, so records without one all collide on
   * `undefined === undefined` and each save overwrites the first. The same undefined-id hazard that
   * deleted 21 pipeline records against Mongo earlier.
   */
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
    /**
     * A deployment still deploying is not something to plan against — a leaf written to connect to
     * it would reach an address that answers nothing. Another tenant's is not visible at all.
     */
    const db = await seeded();
    for (const d of deployments) await db.saveDeployment(d as any);
    const names = (await run(db, 'list_infrastructure')).body.running.map((s: any) => s.name);
    expect(names).not.toContain('half-built');
    expect(names).not.toContain('someone-elses');
  });

  it('lists what CAN be deployed, and mongo is not among it', async () => {
    // The exact request that could not be satisfied.
    const db = await seeded();
    const ids = (await run(db, 'list_infrastructure')).body.deployable.map((d: any) => d.id);
    expect(ids).toContain('qdrant');
    expect(ids).not.toContain('mongo');
    expect(ids).not.toContain('mongodb');
  });

  it('says what each deployable thing IS, not just its id', async () => {
    /**
     * The half that makes the list usable. `qdrant`, `tei` and `quickwit` are unguessable from
     * their names, so a model could neither pick the right one nor recognise the alternative to
     * something absent.
     */
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
    // Same reason: "koala-vectors, type qdrant" is not something to reason from.
    const db = await seeded();
    for (const d of deployments) await db.saveDeployment(d as any);
    const running = (await run(db, 'list_infrastructure')).body.running;
    expect(running.find((s: any) => s.name === 'koala-vectors').is).toMatch(/vector database/);
    expect(running.find((s: any) => s.name === 'koala-store').provides).toContain('object-storage');
  });

  it('says what an absence MEANS, since a long list hides it', async () => {
    // A model reading twenty-six app types will not notice `mongo` is missing unless told.
    const db = await seeded();
    const out = await run(db, 'list_infrastructure');
    expect(out.body.note).toMatch(/does not exist here and cannot be built/);
    expect(out.body.note).toMatch(/do not invent one/);
  });

  it('invents no connection strings', async () => {
    /**
     * A plausible-looking address is worse than none: every service here is addressed differently,
     * and a URL this invented would be indistinguishable to a model from one it was told.
     */
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
  /**
   * Adding a deployable app is a RECORD now, not a construct — so this is how Koala closes the gap
   * that started all of it: asked for MongoDB caching on a platform with no MongoDB, it can now
   * propose one instead of planning around the absence.
   *
   * Proposed and accepted like everything else it creates. A spec runs containers in someone's
   * cluster, and the moment before it exists is the cheapest place to look at it.
   */
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
    /**
     * Validated at propose time so the refusal reaches the model while it still has the context to
     * fix it. The same check runs again on accept, because a proposal can sit for a week.
     */
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
    /**
     * It used to refuse this, on the reasoning that an edit is a different decision from an
     * addition. True — and why the proposal is marked — but refusing outright left no way to
     * correct a broken spec at all. Koala hit exactly that: it found its own MongoDB crash-looping,
     * worked out it needed fixing, and could not propose the fix. It called it a catch-22.
     */
    const db = await seeded();
    await db.saveAppSpec({ id: 'mongo', spec: mongo as any, builtIn: false, createdAt: 'n', updatedAt: 'n' });
    const out = await run(db, 'propose_spec', { ...mongo, args: [] });
    expect(out.proposedSpec?.replaces).toBe(true);
    expect(out.body.note).toMatch(/keeps running until it is redeployed/);
  });

  it('still refuses to rewrite a BUILT-IN', async () => {
    // Those ship with the platform and a test pins the list; a conversation rewriting one would
    // have a fresh clone and a running instance disagreeing about what minio is.
    const db = await seeded();
    await db.saveAppSpec({ id: 'minio', spec: mongo as any, builtIn: true, createdAt: 'n', updatedAt: 'n' });
    expect((await run(db, 'propose_spec', { ...mongo, id: 'minio' })).body.error)
      .toMatch(/ships with the platform/);
  });

  it('is offered, and told never to write a password', async () => {
    /**
     * The rule that keeps a spec safe to author. A generated credential is minted by the platform
     * and injected from a Secret; Koala never holds one and never writes one down.
     */
    const tool = KOALA_TOOLS.find((t) => t.function.name === 'propose_spec')!;
    const env: any = (tool.function.parameters as any).properties.env;
    expect(env.description).toMatch(/Never write a password here/);
    expect((tool.function.parameters as any).required).toContain('resources');
  });
});


describe('knowing that something it built is broken', () => {
  /**
   * ── WHY VALIDATION WAS NEVER GOING TO BE ENOUGH ──
   * The first spec Koala wrote deployed and crash-looped: it set `--noauth` alongside root
   * credentials, and Mongo refuses to start with both —
   * `auth is not allowed when noauth is specified`. No generic validator catches that. It is one
   * app's flag semantics, and encoding every app's would be writing the fifteen constructs again in
   * another form.
   *
   * So the answer is a feedback loop, not more rules. The reconciliation loop already probes and
   * writes `healthReason`; this is what carries it back to the thing that can fix the spec.
   */
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
    // Not broken, not finished. Reporting it would have Koala fixing something that is working.
    const db = await seeded();
    for (const d of broken) await db.saveDeployment(d as any);
    const names = (await run(db, 'list_infrastructure')).body.broken.map((b: any) => b.name);
    expect(names).not.toContain('starting');
    expect(names).not.toContain('theirs');
  });

  it('tells Koala to fix the SPEC rather than redeploy it unchanged', async () => {
    /**
     * The instruction that makes the loop a loop. Without it the obvious move is to try again, and
     * a spec that cannot start does not start the second time either.
     */
    const db = await seeded();
    for (const d of broken) await db.saveDeployment(d as any);
    expect((await run(db, 'list_infrastructure')).body.note).toMatch(/propose a corrected one/);
  });

  it('says nothing about broken things when nothing is', async () => {
    // A permanently present empty list is noise that stops being read.
    const db = await seeded();
    await db.saveDeployment(broken[1] as any);
    const out = await run(db, 'list_infrastructure');
    expect(out.body.broken).toBeUndefined();
    expect(out.body.note).not.toMatch(/propose a corrected one/);
  });

  it('falls back to the status when no reason was recorded', async () => {
    // "Unhealthy" alone still beats silence; it just sends someone to kubectl.
    const db = await seeded();
    await db.saveDeployment({ id: 'd9', name: 'x', appType: 'mongo', status: 'failed', ownerId: 'u1' } as any);
    expect((await run(db, 'list_infrastructure')).body.broken[0].reason).toBe('status is failed');
  });
});


describe('Koala can wire up what it discovers', () => {
  /**
   * It could SEE infrastructure and not act on it: asked to make a service cache in mongo it would
   * find the database, propose a project, and stop — a plausible answer from something that quietly
   * cannot do the thing. A person should not have to know which surface is able to act.
   */
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
