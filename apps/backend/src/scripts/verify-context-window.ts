import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

import { createDatabase } from '../lib/db-interface.js';
import { createModelService } from '../lib/model-wiring.js';
import { fittedMaxTokens, FALLBACK_CONTEXT_TOKENS, FILE_TURN_MAX_TOKENS } from '../lib/sampling.js';

const SYNTHESIST_PROMPT_TOKENS = 29_450;

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const ownerId = (await db.getDeployments())[0]?.ownerId;
    if (!ownerId) return console.log('No deployments.');

    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const providers = await models.list(ownerId);

    console.log(`\nfallback when nobody recorded a window: ${FALLBACK_CONTEXT_TOKENS}\n`);
    for (const p of providers) {
      console.log(`  ${p.name.padEnd(24)} source=${p.source.padEnd(10)} `
        + `window=${p.contextTokens ?? `(none — falls back to ${FALLBACK_CONTEXT_TOKENS})`}`);
    }

    const { provider } = await models.resolveBaseUrl(ownerId);
    const window = provider.contextTokens;
    console.log(`\nresolved for a run with no persona override: ${provider.name} -> ${window ?? 'fallback'}`);

    const promptChars = SYNTHESIST_PROMPT_TOKENS * 4;
    const before = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, FALLBACK_CONTEXT_TOKENS);
    const after = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, window);

    console.log(`\nThe Synthesist's turn (prompt ${SYNTHESIST_PROMPT_TOKENS} tokens, ceiling ${FILE_TURN_MAX_TOKENS}):`);
    console.log(`  max_tokens the harness used to send: ${before}`);
    console.log(`  max_tokens it sends now:             ${after}`);
    console.log(after >= FILE_TURN_MAX_TOKENS
      ? '\nIt can now emit its deliverable in one call.'
      : '\nStill capped below the ceiling — check the resolved window above.');
  } finally {
    await db.close();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
