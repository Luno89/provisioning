import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

import { randomUUID } from 'crypto';
import { createDatabase } from '../lib/db-interface.js';
import { acceptLeaf } from '../lib/accept-leaf.js';
import { TemporalBridge } from '../services/TemporalBridge.js';
import type { Leaf } from '../lib/leaves.js';

const TREE_NAME = 'Self-Hosted LLM Web Design (rerun)';

const RESEARCH = [
  {
    title: 'Research prompting and skill-layer techniques for LLM web design',
    body: 'How do people get open-weight, self-hosted models to produce good web design? Cover system-prompt '
      + 'structure, design-token and design-system conditioning, few-shot exemplars, and critique/refine loops. '
      + 'Name concrete projects and cite URLs.',
  },
  {
    title: 'Research scaffolding and tooling for LLM web design',
    body: 'What scaffolding makes LLM-generated frontends work — component libraries, starter templates, '
      + 'renderers, preview/iteration harnesses, and open-source alternatives to hosted generative-UI tools. '
      + 'Name concrete projects and cite URLs.',
  },
  {
    title: 'Research evaluation methods for LLM-generated web design',
    body: 'How is LLM-generated web design evaluated? Cover benchmarks, visual-diff and screenshot scoring, '
      + 'automated accessibility and responsiveness checks, and human rubrics. Name concrete benchmarks and '
      + 'cite URLs.',
  },
  {
    title: 'Research model selection and tuning for frontend code generation',
    body: 'Which open-weight models are actually good at frontend code, and how are they tuned or sampled for '
      + 'it? Cover model families and sizes, quantisation trade-offs, sampling settings, and context needs. '
      + 'Cite URLs.',
  },
];

const SYNTHESIS = {
  title: 'Synthesize the self-hosted LLM web-design playbook',
  body: 'Combine the four research inputs into one practical playbook for producing good web design with a '
    + 'self-hosted open-weight model. Read every input file first. Structure it as: recommended model and '
    + 'sampling, prompt and skill-layer structure, scaffolding and tooling, the iteration loop, and how to '
    + 'evaluate the output. Every section must contain concrete recommendations drawn from the inputs, with '
    + 'the sources carried through.',
};

const now = () => new Date().toISOString();

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const bridge = new TemporalBridge(db, undefined, process.env.JWT_SECRET ?? '');
  await bridge.start().catch((err: Error) => { console.warn(`Temporal unreachable: ${err.message}`); return bridge; });

  try {
    const personas = await db.getPersonas();
    const ownerId = personas[0]?.ownerId ?? (await db.getDeployments())[0]?.ownerId;
    if (!ownerId) return console.log('No owner found.');

    const byName = (n: string) => personas.find((p: any) => p.ownerId === ownerId && p.name === n);
    const researcher = byName('Researcher');
    const synthesist = byName('Synthesist');
    if (!researcher || !synthesist) {
      return console.log(`Missing personas. Have: ${personas.filter((p: any) => p.ownerId === ownerId).map((p: any) => p.name).join(', ')}`);
    }

    if (process.argv.includes('--retry-failed')) {
      const trees = (await db.getTrees()).filter((t: any) => t.ownerId === ownerId && t.name === TREE_NAME);
      const tree = trees[trees.length - 1];
      const branchIds = new Set((await db.getBranches()).filter((b: any) => b.treeId === tree?.id).map((b: any) => b.id));
      const leaves = (await db.getLeaves()).filter((l: any) => branchIds.has(l.branchId));

      for (const failed of leaves.filter((l: any) => l.status === 'failed')) {
        const reset = { ...failed, status: 'proposed' as const, updatedAt: now() };
        await db.saveLeaf(reset);
        const result = await acceptLeaf(
          { db, startLeaf: (x) => bridge.startLeaf(x), personaOf: async (id) => (id ? personas.find((p: any) => p.id === id) ?? null : null) },
          reset,
          leaves.map((l: any) => (l.id === reset.id ? reset : l)),
        );
        console.log(`  ${result.ok ? 'retrying' : `HELD — ${result.error}`}  ${failed.title.slice(0, 56)}`);
      }
      return;
    }

    if (process.argv.includes('--playbook')) {
      const trees = (await db.getTrees()).filter((t: any) => t.ownerId === ownerId && t.name === TREE_NAME);
      const tree = trees[trees.length - 1];
      const branchIds = new Set((await db.getBranches()).filter((b: any) => b.treeId === tree?.id).map((b: any) => b.id));
      const leaves = (await db.getLeaves()).filter((l: any) => branchIds.has(l.branchId));
      const synth = leaves.find((l: any) => l.title === SYNTHESIS.title);

      if (!synth?.findings?.trim()) {
        console.log(`No playbook yet — the Synthesist is ${synth?.status ?? 'missing'}.`);
        return;
      }
      console.log(synth.findings);
      return;
    }

    if (process.argv.includes('--status') || process.argv.includes('--watch')) {
      return await report(db, ownerId, process.argv.includes('--watch'));
    }

    const treeId = randomUUID();
    const branchId = randomUUID();
    await db.saveTree({
      id: treeId, ownerId, name: TREE_NAME, type: 'research',
      goal: 'A practical playbook for self-hosted LLM web design.',
      createdAt: now(), updatedAt: now(),
    } as never);
    await db.saveBranch({
      id: branchId, ownerId, treeId, title: TREE_NAME, messages: [],
      acceptance: [
        {
          name: 'Playbook covers every area the research fed it',
          command: "grep -qi 'prompt' findings.md && grep -qi 'scaffold' findings.md "
            + "&& grep -qi 'model' findings.md && grep -qi 'evaluat' findings.md",
        },
        { name: 'Playbook carries sources through', command: "grep -qi 'http' findings.md" },
      ],
      createdAt: now(), updatedAt: now(),
    } as never);

    const leaf = (over: Partial<Leaf>): Leaf => ({
      id: randomUUID(), ownerId, branchId,
      title: '', body: '', status: 'proposed', column: 'todo', depth: 0, blocking: true,
      createdAt: now(), updatedAt: now(),
      ...over,
    } as Leaf);

    const researchLeaves = RESEARCH.map((r) => leaf({
      title: r.title, body: r.body, personaId: researcher.id,
      expects: ['findings.md'],
    }));
    const synthesisLeaf = leaf({
      title: SYNTHESIS.title, body: SYNTHESIS.body, personaId: synthesist.id,
      expects: ['findings.md'],
      dependsOn: researchLeaves.map((l) => l.id),
    });

    for (const l of [...researchLeaves, synthesisLeaf]) await db.saveLeaf(l);

    console.log(`\ntree ${treeId}\nbranch ${branchId}`);
    console.log(`${researchLeaves.length} Researchers + 1 Synthesist depending on all ${researchLeaves.length}\n`);

    const all = await db.getLeaves();
    let started = 0;
    for (const l of [...researchLeaves, synthesisLeaf]) {
      const result = await acceptLeaf(
        {
          db,
          startLeaf: (x) => bridge.startLeaf(x),
          personaOf: async (id) => (id ? personas.find((p: any) => p.id === id) ?? null : null),
        },
        l,
        all,
      );
      if (result.ok) started++;
      console.log(`  ${result.ok ? 'accepted' : `HELD — ${result.error}`}\n     ${l.title.slice(0, 66)}`);
    }

    console.log(started
      ? `\n${started} started. Follow with --watch, or check later with --status.`
      : '\nNothing started.');
  } finally {
    await db.close();
  }
}

async function report(db: any, ownerId: string, watch: boolean): Promise<void> {
  for (;;) {
    const trees = (await db.getTrees()).filter((t: any) => t.ownerId === ownerId && t.name === TREE_NAME);
    const tree = trees[trees.length - 1];
    if (!tree) return console.log('No such tree — run without --status first.');

    const branchIds = new Set((await db.getBranches()).filter((b: any) => b.treeId === tree.id).map((b: any) => b.id));
    const leaves = (await db.getLeaves()).filter((l: any) => branchIds.has(l.branchId));

    console.clear();
    console.log(`${TREE_NAME}   ${new Date().toLocaleTimeString()}\n`);
    for (const l of leaves) {
      const usage = l.usage?.tokens ? `${Math.round(l.usage.tokens / 1000)}k` : '—';
      console.log(`  ${String(l.status).padEnd(10)} ${usage.padStart(6)}  ${String(l.findings?.length ?? 0).padStart(6)} chars  ${l.title.slice(0, 52)}`);
      if (l.status === 'failed' && l.summary) console.log(`             ${String(l.summary).replace(/\s+/g, ' ').slice(0, 150)}`);
    }

    const done = leaves.every((l: any) => ['succeeded', 'failed', 'cancelled'].includes(l.status));
    if (!watch || done) {
      if (done) console.log('\nAll leaves have settled.');
      return;
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
