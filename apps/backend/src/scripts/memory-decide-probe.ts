/**
 * Drives the admission decision against the live model and the live search stack.
 *
 *   npx tsx apps/backend/src/scripts/memory-decide-probe.ts
 *
 * ── WHAT THIS COVERS THAT UNIT TESTS CANNOT ──
 * `memory-decide.test.ts` proves the parser and the safety rules hold for any reply. It cannot prove
 * the model produces a usable reply at all — and that is exactly where the judge failed three times
 * before it worked: a reasoning model spent its whole ceiling deliberating and emitted an empty
 * `content`, which parsed as "no opinion" and looked like a working feature.
 *
 * So this runs the real thing on two candidates with known right answers: one that duplicates
 * something already stored, and one that is genuinely new. Writes nothing.
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

import { createDatabase } from '../lib/db-interface.js';
import { createModelService } from '../lib/model-wiring.js';
import { readStreamedReply } from '../lib/agent-loop.js';
import { buildModelRequest } from '../lib/model-request.js';
import { corpusEndpoints } from '../lib/web-tools-resolver.js';
import { searchMemories, bodyOf } from '../lib/memory-index.js';
import { admitMemory } from '../lib/memory-decide.js';
import type { MemoryItem } from '../lib/memory-store.js';

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();

  try {
    const all = await db.getMemories();
    const live = all.filter((m) => !m.invalidAt && m.status !== 'pending_review');
    const ownerId = live[0]?.ownerId;
    if (!ownerId) return console.log('No live memories to decide against.');

    const ends = await corpusEndpoints(db, ownerId);
    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(ownerId);
    console.log(`model: ${provider.model ?? '(default)'} at ${baseUrl}\n`);

    const neighbours = async (m: MemoryItem) => {
      const hits = await searchMemories(ends, bodyOf(m), { ownerId });
      const byId = new Map(all.map((x) => [x.id, x]));
      const found = hits.map((h) => byId.get(h.id)).filter((x): x is MemoryItem => x !== undefined);
      return found.filter((x) => x.category === m.category
        && !x.invalidAt
        && x.id !== m.id
        && (x.projectId ?? '') === (m.projectId ?? '')
        && (x.scope ?? 'global') === (m.scope ?? 'global'));
    };

    const ask = async (prompt: string) => {
      const body = buildModelRequest({
        turn: 'tool-turn',
        ...(provider.kind ? { kind: provider.kind } : {}),
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        maxTokens: 600,
        ...(provider.model ? { model: provider.model } : {}),
        overrides: { think: false },
      }).body;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`model returned ${res.status}`);
      const reply = await readStreamedReply(res as never);
      const answer = (reply.content ?? '').trim() || (reply.reasoning ?? '').trim();
      console.log(`    model said: ${answer.replace(/\s+/g, ' ').slice(0, 160)}`);
      return answer;
    };

    // A near-copy of something already stored. The right answer is NOOP or UPDATE — never ADD.
    const existing = live.find((m) => m.category === 'environment_facts') ?? live[0]!;
    const duplicate: MemoryItem = {
      ...existing,
      id: 'probe-duplicate',
      text: `${existing.text.slice(0, 600)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Nothing in the bank is about this. The right answer is ADD.
    const novel: MemoryItem = {
      id: 'probe-novel',
      ownerId,
      ...(existing.projectId ? { projectId: existing.projectId } : {}),
      category: existing.category,
      scope: existing.scope ?? 'global',
      status: 'active',
      title: 'The Postgres container needs a 90s start period',
      text: 'Integration tests against Postgres fail on a cold machine because the container reports '
        + 'healthy before it accepts connections. Give the healthcheck a 90 second start period.',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    for (const [label, candidate, expected] of [
      ['DUPLICATE of a stored memory', duplicate, 'NOOP or UPDATE'],
      ['GENUINELY NEW', novel, 'ADD'],
    ] as const) {
      console.log(`\n${'─'.repeat(74)}\n${label} — expecting ${expected}`);
      console.log(`  candidate: "${candidate.title}"`);
      const seen = await neighbours(candidate);
      console.log(`  neighbours retrieved: ${seen.length}`);
      for (const n of seen.slice(0, 5)) console.log(`    · ${n.title}`);

      const began = Date.now();
      const { decision, write } = await admitMemory({ neighbours, ask }, candidate);
      console.log(`  -> ${decision.action}${'targetId' in decision ? ` ${decision.targetId}` : ''}`
        + `  (${Date.now() - began}ms, would write ${write.length} row(s))`);
    }
  } finally {
    await db.close();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
