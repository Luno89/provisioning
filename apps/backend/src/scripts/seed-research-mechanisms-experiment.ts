/**
 * Does the model actually do the things the research architecture asks of it?
 *
 * ── WHY THIS EXPERIMENT EXISTS ──
 * The question-loop design asks the model for four separate behaviours: answer one narrow question
 * from sources, stay inside the question it was given, say so when the answer is not findable, and
 * turn several separate answers into one piece without searching again. Every one of those is an
 * assumption, and this platform has spent a week discovering that assumptions about model behaviour
 * are wrong in specific, expensive ways.
 *
 * The broad-question failure is already measured: five runs, five configurations, no deliverable.
 * The narrow-question success is measured too: 45 seconds, verified, correctly cited. What is NOT
 * measured is whether the role prompts help, and that is what the variants are for — a persona is
 * only worth having if it beats not having one on the same suite.
 *
 * ── WHAT THE VERIFY COMMANDS CAN AND CANNOT SEE ──
 * They check that an artefact exists and has the shape of an answer: a URL, a mention of the thing
 * asked about, an admission where one is due. They cannot check that the answer is TRUE. That is
 * the same bar as the artifact check on a normal leaf, and it is deliberately not dressed up as
 * more: what it catches is the failure that actually happens, which is producing nothing, producing
 * a stub, or confidently inventing.
 *
 * Run with: npx tsx src/scripts/seed-research-mechanisms-experiment.ts
 */
import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Experiment } from '@koala/harness-types';

const OWNER = '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991';
const NAME = 'Research mechanisms';

async function main() {
  const mongo = new MongoDB();
  await mongo.init();

  for (const item of (await mongo.getExperiments()).filter((e) => e.name === NAME)) {
    await mongo.deleteExperiment(item.id);
  }

  /**
   * Personas are looked up by NAME, not hardcoded by id.
   *
   * The ids differ per machine, and an experiment referring to a persona that does not exist here
   * would run every arm identically while reporting a comparison — the exact failure the tunable
   * registry exists to prevent one level down.
   */
  const personas = (await mongo.getPersonas()).filter((p) => p.ownerId === OWNER);
  const researcher = personas.find((p) => p.name === 'Researcher');
  if (!researcher) throw new Error('No "Researcher" persona for this owner — create it before seeding.');

  const now = new Date().toISOString();
  const experiment: Experiment = {
    id: uuidv4(),
    ownerId: OWNER,
    name: NAME,
    language: 'node',
    status: 'draft',
    // Required on the type, and empty is the honest starting value — the arms have not run yet.
    results: [],
    // Two runs per arm. These tasks hit the live web, so a single run confuses "the persona is
    // worse" with "that page was slow today".
    repeats: 2,
    createdAt: now,
    updatedAt: now,
    variants: [
      // The control. Without it, a suite that all four arms pass says nothing about the prompts.
      { label: 'no-persona', overrides: { temperature: 0.4 } },
      { label: 'researcher-persona', overrides: {}, personaId: researcher.id },
      // Same persona, colder. Research is recall and transcription, not invention — this arm exists
      // to find out whether the temperature in the persona is doing anything at all.
      { label: 'researcher-cold', overrides: { temperature: 0.1 }, personaId: researcher.id },
    ],
    tasks: [
      {
        id: 'r1',
        name: 'narrow-answer-with-source',
        prompt:
          'Answer exactly one question: which software licence is the Restate durable-execution engine '
          + 'released under? Write the licence name and the URL you found it on to /work/answer.md. '
          + 'Two or three sentences is enough.',
        // A URL is the artefact of having actually looked. Requiring the licence name too stops a
        // file that cites a page and never says what it found.
        verifyCommand:
          'test -s /work/answer.md && grep -qiE "https?://" /work/answer.md '
          + '&& grep -qiE "BSL|business source|apache" /work/answer.md',
      },
      {
        id: 'r2',
        name: 'stays-inside-the-question',
        prompt:
          'Answer exactly one question: what is the default gRPC port that a Temporal frontend service '
          + 'listens on? Write the answer and its source URL to /work/port.md. Do not write about '
          + 'anything else — not installation, not pricing, not SDKs.',
        // Scope is checked by SIZE as well as content: the failure here is not a wrong port, it is
        // a four-page essay about Temporal that happens to contain one.
        verifyCommand:
          'test -s /work/port.md && grep -q "7233" /work/port.md && grep -qiE "https?://" /work/port.md '
          + '&& test "$(wc -c < /work/port.md)" -lt 2000',
      },
      {
        id: 'r3',
        name: 'admits-what-it-cannot-find',
        prompt:
          'Answer exactly one question: what is the exact per-seat monthly list price of Restate Cloud '
          + 'for an on-premises air-gapped deployment? Write your answer to /work/price.md. '
          + 'If this is not published anywhere, say so plainly and say what you checked. Do not guess a number.',
        /**
         * The invention check, and the one that matters most.
         *
         * There is no such published price. An arm that writes a confident figure has done the thing
         * that makes a research harness worse than useless, so this passes only on an admission.
         */
        verifyCommand:
          'test -s /work/price.md && grep -qiE "not publish|no publish|not listed|unable|could not|not available|no public|contact" /work/price.md',
      },
      {
        id: 'r4',
        name: 'synthesises-without-searching',
        prompt:
          'Below are two answers that were researched separately. Combine them into one short piece and '
          + 'write it to /work/brief.md. Carry both source URLs through. Where they disagree, say so '
          + 'plainly rather than choosing one. Do not search for anything else.\n\n'
          + 'ANSWER A: Temporal is released under the MIT licence. Source: https://github.com/temporalio/temporal/blob/main/LICENSE\n'
          + 'ANSWER B: Restate is released under the Business Source License 1.1, converting to Apache 2.0 '
          + 'after four years. Source: https://github.com/restatedev/restate/blob/main/LICENSE',
        // Both URLs must survive. Dropping a source while keeping the claim is how a synthesis step
        // quietly launders cited work into an assertion.
        verifyCommand:
          'test -s /work/brief.md && grep -q "temporalio/temporal" /work/brief.md '
          + '&& grep -q "restatedev/restate" /work/brief.md '
          + '&& grep -qiE "MIT" /work/brief.md && grep -qiE "business source|BSL" /work/brief.md',
      },
    ],
  };

  await mongo.saveExperiment(experiment);
  console.log(`Seeded "${NAME}" (${experiment.id}) — ${experiment.variants.length} arms x ${experiment.tasks!.length} tasks x ${experiment.repeats} repeats`);
  process.exit(0);
}

main();
