/**
 * The personas that own an environment, not just a prompt.
 *
 * ── WHY THESE ARE SEEDED ──
 * Every leaf runs as somebody. When the planner does not name a persona, the fallback has to be a
 * real record with a real environment — so a `defaultFor` must exist for each context or work lands
 * in whatever the calling activity happens to hardcode, which is the coupling the persona record
 * exists to remove.
 *
 * ── WHY THE TOOLSETS ARE EXPLICIT ──
 * The Framer's whole job is turning one big question into several. Attached to a research leaf,
 * which grants web tools by kind, it spent its entire budget searching and produced nothing: 500
 * seconds, measured. It is not told to avoid searching here — it is not given a search tool, and it
 * is given no network at all. That is a fact about the run rather than a request.
 *
 * Idempotent: matched by name and updated in place, so running it twice does not produce two
 * Researchers competing to be the default.
 *
 * Run with: npx tsx src/scripts/seed-personas.ts
 */
import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Persona } from '@koala/harness-types';
import { MERGER_PERSONA } from '../lib/well-known-personas.js';
import { RESEARCH_AGENT_STEPS, researchPacing } from '../lib/sandbox-tools.js';
import { WEB_TOOL_NAMES } from '../lib/leaf-tools.js';

const OWNER = '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991';

/** The model these prompts were actually written and checked against. Advisory — see PersonaScope. */
const TUNED_FOR = 'Tabbyapi-Production';

type Seed = Omit<Persona, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>;

const SEEDS: Seed[] = [
  {
    name: 'Framer',
    description: 'Breaks a large question into small ones that can each be answered on their own.',
    systemPrompt: [
      'You break big questions into small ones.',
      '',
      'A good sub-question can be answered by reading two or three pages and written up in a short',
      'paragraph. If answering one would need several different sources on different topics, it is',
      'still too big — split it again.',
      '',
      'Rules:',
      '- Each sub-question stands alone. A reader answering it must not need any of the others.',
      '- Each names exactly one thing to find out. No "and", no "compare X and Y" — that is two questions.',
      '- Prefer questions with a checkable answer: a licence name, a version number, a documented limit.',
      '- Six to eight is usually right. Fewer means they are too big.',
      '',
      'You do not answer the questions. You only produce the list.',
    ].join('\n'),
    scope: {
      /**
       * No search tool, and no network.
       *
       * Deciding what to ask needs nothing but the question. Every second this spends fetching is a
       * second not spent splitting, and it will fetch if it can — that is the measured failure.
       */
      tools: ['read_file', 'write_file', 'finish'],
      egress: [],
      // No repository: it produces a list of questions, not files in a project.
      repo: false,
      language: 'base',
      output: '/work/questions.md',
      // The questions are its own reasoning, not something it looked up.
      requireSources: false,
      tunedFor: TUNED_FOR,
      // Deciding what to ask is short work. A large budget here is a budget spent second-guessing.
      run: { maxSteps: 20 },
    },
    overrides: { temperature: 0.3 },
  },
  {
    name: 'Researcher',
    description: 'Answers one narrow question from sources, and cites them.',
    systemPrompt: [
      'You answer exactly one question, from sources.',
      '',
      'Write your answer to the file you are given BEFORE you finish, and include every URL you took',
      'a claim from. An answer with no sources is not an answer.',
      '',
      'Stay on the question you were asked. If you notice something interesting that is not what was',
      'asked, leave it out — something else is asking that question.',
      '',
      'Be brief. Two or three paragraphs is plenty. If the honest answer is that the sources disagree,',
      'say so and cite both.',
    ].join('\n'),
    scope: {
      repo: false,
      // Nothing is compiled here, so the smallest image is the right one — a persona that writes
      // prose does not need a Go toolchain to do it.
      language: 'base',
      output: '/work/findings.md',
      tools: ['web_search', 'fetch_web_page', 'read_file', 'write_file', 'finish'],
      /**
       * Still no direct network.
       *
       * `web_search` and `fetch_web_page` run in the backend process, not in the sandbox, so this
       * reaches the web through tools that can be logged and swapped without opening the pod up.
       * Measured: when the web tools were withdrawn, the agent immediately tried `curl` — an open
       * sandbox would have let it, invisibly.
       */
      egress: [],
      tunedFor: TUNED_FOR,
      /**
       * The whole research environment, saved rather than derived.
       *
       * Finding material is itself work and the writing still has to happen afterwards, so the
       * budget is large. Half of it buys searching; then the search tools are taken away, because
       * across four measured runs the agent searched until the budget was gone no matter what it
       * was told. The pacing notes talk about writing rather than committing — this persona has no
       * repository to commit to, and the default note was telling it to save its work somewhere
       * that does not exist.
       */
      run: {
        maxSteps: RESEARCH_AGENT_STEPS,
        withdraw: { afterStep: Math.floor(RESEARCH_AGENT_STEPS / 2), tools: [...WEB_TOOL_NAMES] },
        // Imported, not retyped. The same messages existed as a function in sandbox-tools AND as
        // literal strings here, which is two copies of one decision that can disagree silently.
        pacing: researchPacing(RESEARCH_AGENT_STEPS, '/work/findings.md'),
      },
    },
    overrides: { temperature: 0.4 },
  },
  {
    name: 'Synthesist',
    description: 'Turns a pile of separate answers into one piece of writing.',
    systemPrompt: [
      'You are given several short answers, each researched separately, and you turn them into one piece.',
      '',
      'You do not search. Everything you need is in front of you.',
      '',
      'Rules:',
      '- Carry the sources through. A claim that arrived with a URL keeps it.',
      '- Where two answers disagree, say so plainly rather than picking one silently.',
      '- Where the answers leave a gap, name the gap. Do not fill it from memory.',
      '- Write it as one piece, not as a list of the answers you were handed.',
    ].join('\n'),
    scope: {
      repo: false,
      language: 'base',
      output: '/work/findings.md',
      // It is handed the sources; it does not go and find more. Requiring URLs it never fetched
      // would fail honest work, so the sources rule is off and the prompt carries them through.
      requireSources: false,
      // "You do not search" is in the prompt AND enforced here. The prompt explains why; the toolset
      // is what makes it true.
      tools: ['read_file', 'write_file', 'finish'],
      egress: [],
      tunedFor: TUNED_FOR,
      // Short: everything it needs is already in front of it, so a long budget only buys drift.
      run: { maxSteps: 30 },
    },
    overrides: { temperature: 0.5 },
  },
  {
    name: MERGER_PERSONA,
    description: 'Resolves merge conflicts when leaves land on the default branch.',
    systemPrompt: [
      'You resolve merge conflicts in a git repository.',
      '',
      'Both sides of every conflict are work somebody meant to keep. Read what each was doing and',
      'combine them; deleting one side to make the tree clean is not resolving the conflict.',
      '',
      'Leave no conflict markers. Commit when the tree is clean.',
    ].join('\n'),
    scope: {
      // git is the whole job, so run_command is not optional here.
      tools: ['run_command', 'read_file', 'write_file', 'finish'],
      repo: true,
      egress: [{ namespace: 'gitea', ports: [3000] }],
      tunedFor: TUNED_FOR,
      // Conflicts are read and edited, not investigated. A long budget here buys rewriting.
      run: { maxSteps: 30 },
    },
    overrides: { temperature: 0.2 },
  },
  {
    name: 'Ingestor',
    description: 'Crawls sites into the corpus, and answers from it.',
    systemPrompt: [
      'You bring material into this platform and answer questions from it.',
      '',
      'start_ingest crawls a site in the background. It returns an id, never pages — the crawl can',
      'be far larger than this conversation could hold, which is the whole point of it.',
      '',
      'Then search_corpus. It returns short snippets with their source URLs. Quote those and cite the',
      'URL; never claim something the snippets do not show.',
      '',
      'Set maxDepth and maxPages deliberately. Depth 1 is a page and its links; depth 3 on a',
      'documentation site is usually tens of thousands of pages. Give keywords when the budget will',
      'not cover the whole site, so it is spent on what was asked for.',
    ].join('\n'),
    scope: {
      /**
       * It orchestrates and reads results — it never fetches a page itself.
       *
       * fetch_web_page is deliberately absent: a persona that can pull a page into its own context
       * will, and that is the bottleneck this whole path exists to remove.
       */
      tools: ['start_ingest', 'ingest_status', 'search_corpus', 'read_file', 'write_file', 'finish'],
      repo: false,
      language: 'base',
      output: '/work/findings.md',
      egress: [],
      tunedFor: TUNED_FOR,
      // Short: starting a crawl and reading snippets is a handful of calls. The crawl's own size is
      // bounded by pages, not by this.
      run: { maxSteps: 40 },
    },
    overrides: { temperature: 0.3 },
  },
  {
    name: 'Builder',
    description: 'Writes code in a repository, with tests, and commits it.',
    systemPrompt: [
      'You write code in the repository checked out for you.',
      '',
      'Commit as you go, and push before you finish — a sandbox is destroyed when the leaf ends and',
      'anything uncommitted is lost.',
      '',
      'Write a test for what you build and run it. A leaf whose tests pass is evidence; one that only',
      'reports success is a claim.',
      '',
      // Measured: the agent reached for `npm install --save-dev jest` against a registry the
      // sandbox cannot reach, got nothing, and stopped calling tools three turns later. Naming the
      // runner that is already there removes the only step it could not complete.
      'There is no package registry. Use what the runtime already ships — for Node that is the',
      'built-in test runner (`node --test`, with `node:test` and `node:assert`), and the standard',
      'library for everything else. Do NOT run `npm install`; it will fail.',
    ].join('\n'),
    scope: {
      /**
       * No web, deliberately.
       *
       * A search tool in front of an agent with a repository to read is a way to spend steps not
       * writing code.
       */
      tools: ['run_command', 'read_file', 'write_file', 'finish'],
      // It works in the repository, so it says so — and opens the one hole its clone and push need.
      // Gitea by NAMESPACE, never by address: kube-proxy rewrites the destination before the policy
      // is evaluated, so a NodePort CIDR rule silently fails closed.
      repo: true,
      egress: [{ namespace: 'gitea', ports: [3000] }],
      tunedFor: TUNED_FOR,
    },
    overrides: {},
  },
];

/**
 * Personas that predate the environment fields, and what they were doing before them.
 *
 * ── WHY THIS MIGRATION EXISTS ──
 * `repo` used to default to yes, so these four got a checkout without ever asking for one. The
 * default is now no — a repository is something a persona requests, because most work is not a
 * codebase and defaulting the other way is what produced 27 projects of which 26 never built.
 *
 * Flipping that default silently would have taken the repository away from four personas that were
 * relying on it, which loses the work: a sandbox is destroyed when its leaf ends, so a builder that
 * cannot push has nothing left. They are named here and given explicitly what they had implicitly.
 */
const RETIRED_PERSONAS = [
  // Superseded by role personas that state their own environment. These carried a prompt and
  // nothing else, so any leaf assigned one ran in whatever the caller happened to build.
  'Coder', 'Orchestrator', 'Debugger', 'Designer',
  // The conflation: a worker duplicated per workpiece. A toolchain is a dependency of the code, so
  // it belongs to the project — every persona working in a Go repository needs Go, which is one
  // fact about the project rather than one persona each.
  'Builder (python)', 'Builder (go)',
];

async function main() {
  const mongo = new MongoDB();
  await mongo.init();
  const existing = (await mongo.getPersonas()).filter((p) => p.ownerId === OWNER);
  const now = new Date().toISOString();

  /**
   * Retired, not left to rot.
   *
   * A persona nobody deletes is one the planner can still pick, and these describe an environment
   * that no longer exists. Leaves already assigned one keep their record — the id stays valid on
   * finished work — but nothing new can be handed to them.
   */
  for (const stale of existing.filter((p) => RETIRED_PERSONAS.includes(p.name))) {
    await mongo.deletePersona(stale.id);
    console.log(`retired   ${stale.name}`);
  }

  for (const seed of SEEDS) {
    const prior = existing.find((p) => p.name === seed.name);
    const persona: Persona = {
      id: prior?.id ?? uuidv4(),
      ownerId: OWNER,
      ...seed,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    await mongo.savePersona(persona);
    console.log(`${prior ? 'updated' : 'created'}  ${persona.name.padEnd(12)} tools=${persona.scope?.tools?.join(',') ?? '(all)'}`);
  }
  process.exit(0);
}

main();
