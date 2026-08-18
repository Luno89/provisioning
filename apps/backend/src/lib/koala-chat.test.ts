import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { runKoalaTool, type KoalaToolContext } from './koala-tool-runner.js';
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
  return db;
};

const ctx = (db: any, over: Partial<KoalaToolContext> = {}): KoalaToolContext => ({
  db, userId: 'u1', conversationId: 'c1', sessionId: 's1',
  servers: [server()],
  webSearch: async () => [{ title: 't', snippet: 's', url: 'u' }],
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

  it('constrains a proposed type to the real ones', () => {
    const params: any = KOALA_TOOLS.find((t) => t.function.name === 'propose_tree')!.function.parameters;
    expect(Array.isArray(params.properties.type.enum)).toBe(true);
    expect(params.properties.type.enum.length).toBeGreaterThan(0);
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
    const out = await run(db, 'propose_tree', { name: 'GitHub API MCP', goal: 'Wrap the GitHub API.' });
    expect(out.proposed?.name).toBe('GitHub API MCP');
    expect(out.body.note).toMatch(/Nothing is created until the user accepts/);
    expect((await db.getConversations())[0].proposedTrees).toHaveLength(1);
  });

  it('requires a goal, because that is what the planner reads later', async () => {
    const db = await seeded();
    expect((await run(db, 'propose_tree', { name: 'Something' })).body.error).toMatch(/goal is required/);
  });

  it('falls back to a real type rather than storing an invented one', async () => {
    const db = await seeded();
    const out = await run(db, 'propose_tree', { name: 'X', goal: 'Y', type: 'not-a-type' });
    expect(out.proposed?.type).toBeTruthy();
    expect(out.proposed?.type).not.toBe('not-a-type');
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

  it('takes no owner argument on any tool', () => {
    for (const t of KOALA_TOOLS) {
      const props = Object.keys((t.function.parameters as any).properties ?? {});
      expect(props, t.function.name).not.toContain('ownerId');
    }
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
    const out = await run(db, 'list_infrastructure');
    expect(out.body.deployable).toContain('qdrant');
    expect(out.body.deployable).not.toContain('mongo');
    expect(out.body.deployable).not.toContain('mongodb');
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
