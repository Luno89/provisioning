import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';

const BASE = process.env.CORPUS_LIVE_URL ?? 'http://localhost:3001/api';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Result { name: string; ok: boolean; digest: string; content?: string }
interface Trace { finish?: unknown; outputs?: { results?: Result[] } }

async function turn(http: AxiosInstance, conversationId: string, message: string): Promise<Result[]> {
  const { runId } = (await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } })).data as { runId: string };
  console.log(`  run ${runId}`);
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    const traces = (await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[];
    if (traces.some((trace) => trace.finish !== undefined)) {
      const seen = new Map<string, Result>();
      for (const result of traces.flatMap((trace) => trace.outputs?.results ?? [])) seen.set(`${result.name}:${result.digest}`, result);
      return [...seen.values()];
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish`);
    await sleep(3_000);
  }
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const ownerId = (await db.getProjects()).find((project) => project.ownerId)?.ownerId;
  assert.ok(ownerId);
  const user = await db.getUserById(ownerId);
  assert.ok(user);
  const secret = loadKeys(process.env).session;
  assert.ok(secret);
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });
  const conversationId = (await http.post('/conversations', {})).data.id as string;
  let ingestId: string | undefined;
  let crawler: string | undefined;

  try {
    const running = (await db.getDeployments()).some((dep) => dep.appType === 'crawl4ai' && dep.status === 'running' && dep.ownerId === ownerId);
    if (!running) {
      const refused = (await turn(http, conversationId, 'Crawl https://example.com into the corpus — only that one page (maxDepth 0, maxPages 1).')).find((result) => result.name === 'start_ingest');
      assert.ok(refused && !refused.ok && refused.digest.includes('crawl4ai'), `start_ingest did not refuse for want of a crawler: ${JSON.stringify(refused)}`);
      console.log('  with no crawler running, start_ingest refused and said to deploy crawl4ai');
      crawler = `crawl-live-${Date.now().toString(36)}`;
      await turn(http, conversationId, `Deploy the crawl4ai app from the catalogue on the management cluster, call it ${crawler}.`);
      const card = ((await http.get('/actions', { params: { conversationId } })).data as { id: string; kind: string; params: Record<string, string> }[])
        .find((entry) => entry.kind === 'deploy_app' && entry.params.name === crawler);
      assert.ok(card, 'koala did not propose deploying crawl4ai');
      await http.post(`/actions/${card.id}/apply`);
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        const dep = ((await http.get('/deployments')).data as { name: string; status: string }[]).find((entry) => entry.name === crawler);
        if (dep?.status === 'running') break;
        if (dep?.status === 'failed' || Date.now() > deadline) throw new Error(`crawl4ai did not come up: ${dep?.status}`);
        await sleep(10_000);
      }
      console.log(`  deployed ${crawler} through its card`);
    }

    const started = (await turn(http, conversationId, 'Crawl https://example.com into the corpus — only that one page (maxDepth 0, maxPages 1).')).find((result) => result.name === 'start_ingest' && result.ok);
    assert.ok(started, 'koala did not start a crawl');
    const id = /(ingest-[0-9a-f]{12}-[0-9a-z]+)/.exec(started.content ?? started.digest)?.[1];
    assert.ok(id, 'no crawl id came back');
    console.log(`  started ${id}`);

    await (async () => {
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        const pages = await db.getCorpusPages({ ownerId });
        const mine = pages.filter((entry) => entry.url.includes('example.com'));
        if (mine.length > 0) { ingestId = mine[0]!.ingestId; return; }
        if (Date.now() > deadline) throw new Error('the crawl stored no page');
        await sleep(5_000);
      }
    })();
    console.log('  the crawl stored example.com in the corpus');

    const searched = await turn(http, conversationId, `The crawl ${id} has finished. Check its status, then search the corpus for "illustrative examples" and tell me which URL it came from.`);
    const hit = searched.find((result) => result.name === 'search_corpus' && result.ok && (result.content ?? '').includes('example.com'));
    assert.ok(hit, `koala found nothing: ${JSON.stringify(searched.map((r) => `${r.name}:${r.digest}`))}`);
    console.log(`  search_corpus: ${hit.digest}`);
    console.log('corpus live — PASS');
  } finally {
    if (ingestId) await db.deleteCorpus(ingestId).catch(() => undefined);
    if (crawler) {
      const dep = ((await http.get('/deployments').catch(() => ({ data: [] }))).data as { id: string; name: string }[]).find((entry) => entry.name === crawler);
      if (dep) await http.delete(`/deployments/${encodeURIComponent(dep.id)}`).catch(() => undefined);
    }
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
