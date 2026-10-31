import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAIL_CHECK_MARK, mailDomainFrom, mailLines, MailReputation } from '../../apps/backend/src/platform/index.js';
import { readEnvFile } from './root-env.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const env: Record<string, string | undefined> = {
  ...readEnvFile(join(REPO, 'apps/backend/.env')),
  ...readEnvFile(process.env.COMPOSE_ENV ?? join(REPO, '.env')),
  ...process.env,
};
const { values, positionals } = parseArgs({ allowPositionals: true, options: { ip: { type: 'string' }, json: { type: 'boolean' } } });
const domain = positionals[0] ?? mailDomainFrom(env);

async function main(): Promise<void> {
  if (!domain) throw new Error('usage: tsx mail-check.ts [domain] [--ip <root\'s public IPv4>] [--json]   (else DOMAIN or MAIL_FROM in root\'s .env)');
  const readiness = await new MailReputation({ domain, ip: values.ip || undefined, relayhost: env.MAIL_RELAYHOST?.trim() || undefined }).check();
  for (const line of mailLines(readiness)) console.log(`  ${line.mark === 'ok' ? '✓' : line.mark === 'problem' ? '!' : '?'} ${line.said}`);
  console.log('  Lines marked ! keep mail from root out of inboxes until they are fixed; ? could not be checked from this host.');
  if (values.json) console.log(`${MAIL_CHECK_MARK} ${JSON.stringify(readiness)}`);
}

main().catch((err: Error) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
