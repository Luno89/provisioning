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
      contexts: ['planning'],
      defaultFor: ['planning'],
      /**
       * No search tool, and no network.
       *
       * Deciding what to ask needs nothing but the question. Every second this spends fetching is a
       * second not spent splitting, and it will fetch if it can — that is the measured failure.
       */
      tools: ['read_file', 'write_file', 'finish'],
      egress: [],
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
      contexts: ['research'],
      defaultFor: ['research'],
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
        maxSteps: 100,
        withdraw: { afterStep: 50, tools: ['web_search', 'fetch_web_page'] },
        pacing: [
          {
            atRemaining: 50,
            message: 'Half your budget is gone. STOP SEARCHING NOW and write what you have to /work/findings.md. '
              + 'You can search again afterwards if something is missing, but the file must exist first.',
          },
          {
            atRemaining: 4,
            message: 'Write /work/findings.md NOW and call `finish`. It is the only thing kept — an answer that '
              + 'exists only in your replies is lost, and an empty file fails the leaf.',
          },
        ],
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
      contexts: ['research'],
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
    ].join('\n'),
    scope: {
      contexts: ['code'],
      defaultFor: ['code'],
      /**
       * No web, deliberately.
       *
       * A search tool in front of an agent with a repository to read is a way to spend steps not
       * writing code. Egress is left UNDECLARED rather than empty, so the checkout's own Gitea rule
       * still applies — a builder that cannot reach Gitea cannot push, and its work is lost.
       */
      tools: ['run_command', 'read_file', 'write_file', 'finish'],
      tunedFor: TUNED_FOR,
    },
    overrides: {},
  },
];

async function main() {
  const mongo = new MongoDB();
  await mongo.init();
  const existing = (await mongo.getPersonas()).filter((p) => p.ownerId === OWNER);
  const now = new Date().toISOString();

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
