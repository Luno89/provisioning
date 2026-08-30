import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

import { createDatabase } from '../lib/db-interface.js';
import { createModelService } from '../lib/model-wiring.js';
import { fittedMaxTokens } from '../lib/sampling.js';
import { requireBudget } from '../lib/pack-defaults.js';

const SYNTHESIST_PROMPT_TOKENS = 29_450;

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const ownerId = (await db.getDeployments())[0]?.ownerId;
    if (!ownerId) return console.log('No deployments.');

    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const budget = await requireBudget(db);
    const providers = await models.list(ownerId);

    console.log(`\nfallback when nobody recorded a window: ${budget.contextTokens}\n`);
    for (const p of providers) {
      console.log(`  ${p.name.padEnd(24)} source=${p.source.padEnd(10)} `
        + `window=${p.contextTokens ?? `(none — falls back to ${budget.contextTokens})`}`);
    }

    const { provider } = await models.resolveBaseUrl(ownerId);
    const window = provider.contextTokens;
    console.log(`\nresolved for a run with no persona override: ${provider.name} -> ${window ?? 'fallback'}`);

    const promptChars = SYNTHESIST_PROMPT_TOKENS * 4;
    const before = fittedMaxTokens(budget, budget.replyTokens.writingFiles, promptChars, budget.contextTokens);
    const after = fittedMaxTokens(budget, budget.replyTokens.writingFiles, promptChars, window);

    console.log(`\nThe Synthesist's turn (prompt ${SYNTHESIST_PROMPT_TOKENS} tokens, ceiling ${budget.replyTokens.writingFiles}):`);
    console.log(`  max_tokens the harness used to send: ${before}`);
    console.log(`  max_tokens it sends now:             ${after}`);
    console.log(after >= budget.replyTokens.writingFiles
      ? '\nIt can now emit its deliverable in one call.'
      : '\nStill capped below the ceiling — check the resolved window above.');
  } finally {
    await db.close();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
