import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import type { Level1Run } from '../apps/backend/src/services/Level1Service.js';

const BASE = process.env.LEVEL1_LIVE_URL ?? 'http://localhost:3001/api';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const repeats = Number(flag('--repeats') ?? 10);
  const existing = flag('--run');
  const only = args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
  if (!existing && only.length === 0) throw new Error('name the cases to run, e.g. npm run test:level1-live -- koala/crawls-a-docs-site');

  const db = createDatabase();
  await db.init();
  const ownerId = (await db.getProjects()).find((project) => project.ownerId)?.ownerId;
  const user = ownerId ? await db.getUserById(ownerId) : undefined;
  await db.close();
  if (!user) throw new Error('no project owner to run as');
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });

  const started = existing
    ? { id: existing }
    : (await http.post('/evals/level1/runs', { only, repeats })).data as Level1Run;
  if (!existing) console.log(`  run ${started.id}: ${only.length} cases × ${repeats}`);
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    const run = (await http.get(`/evals/level1/runs/${started.id}`)).data as Level1Run;
    if (run.state !== 'running') {
      console.log(`  model ${run.modelLabel ?? run.modelId ?? '?'} — ${run.state}${run.error ? `: ${run.error}` : ''}`);
      let failed = run.state !== 'done';
      for (const result of run.results) {
        const passed = result.attempts.filter((attempt) => attempt.passed).length;
        if (passed < result.attempts.length) failed = true;
        console.log(`  ${result.name}: ${passed}/${result.attempts.length} (completion tokens ${result.attempts.map((attempt) => attempt.completionTokens).join(' ')})`);
        for (const miss of result.attempts.filter((attempt) => !attempt.passed)) {
          console.log(`    #${miss.attempt} ${miss.complaint ?? miss.error ?? ''} ${miss.toolCalls.map((call) => call.name).join(', ')}`.slice(0, 240));
          if (miss.thinking) console.log(`      …${miss.thinking.slice(-400).replace(/\s+/g, ' ')}`);
        }
      }
      console.log(`level1 live — ${failed ? 'MISSES' : 'PASS'}`);
      process.exit(failed ? 1 : 0);
    }
    if (Date.now() > deadline) throw new Error(`run ${started.id} did not finish`);
    await sleep(5_000);
  }
}

main().catch((err: unknown) => {
  const response = (err as { response?: { status: number; data: unknown } }).response;
  console.error(response ? `${response.status} ${JSON.stringify(response.data)}` : err);
  process.exit(1);
});
