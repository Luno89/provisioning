import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { claimSettingsFrom, createDatabase, loadKeys, operatorsAmong, roleFromEnv } from '../platform/index.js';
import { CredentialService, ServerOrderService } from '../infrastructure/index.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

async function main(): Promise<void> {
  const plan = arg('plan');
  const datacenter = arg('datacenter');
  if (!plan || !datacenter) {
    console.error('usage: npm run ovh:quote -- --plan <OVHcloud plan code> --datacenter <code> [--owner <operator id>]');
    console.error('Prices the plan in a cart with your stored OVHcloud keys, prints the quote and deletes the cart. It never buys.');
    process.exit(2);
  }
  const db = createDatabase();
  await db.init();
  try {
    const role = roleFromEnv(process.env);
    const keys = loadKeys(process.env);
    const owner = arg('owner') ?? operatorsAmong(await db.accounts.getUsers(), claimSettingsFrom(role))[0]?.id;
    if (!owner) throw new Error('no operator on this box; pass --owner <id>');
    const credentials = new CredentialService(db, keys.data, claimSettingsFrom(role));
    const orders = new ServerOrderService({
      store: db.infrastructure,
      dataKey: keys.data,
      ovhAccountOf: async (ownerId) => {
        const resolved = await credentials.resolveCredentials(ownerId, 'ovh');
        const { OVH_APPLICATION_KEY: applicationKey, OVH_APPLICATION_SECRET: applicationSecret, OVH_CONSUMER_KEY: consumerKey, OVH_SUBSIDIARY: subsidiary } = resolved.env;
        return resolved.mode !== 'mock' && applicationKey && applicationSecret && consumerKey ? { applicationKey, applicationSecret, consumerKey, subsidiary: subsidiary || 'FR' } : undefined;
      },
      cloudflareTokenOf: async () => undefined,
    });
    const quote = await orders.quoteAndDiscard(owner, plan, datacenter);
    console.log(`${plan} in ${datacenter}, priced by OVHcloud (the cart was deleted; nothing was bought):`);
    for (const line of quote.lines) console.log(`  ${line.description}: ${line.amount} ${quote.currency}`);
    console.log(`  monthly ${quote.monthly}, setup ${quote.setupFee}, first payment ${quote.withTax} ${quote.currency} (${quote.withoutTax} + tax ${quote.tax})`);
    for (const contract of quote.contracts) console.log(`  contract: ${contract.name} ${contract.url}`);
  } finally {
    await db.close();
  }
}

main().catch((error: Error) => {
  console.error(`ovh:quote — ${error.message}`);
  process.exit(1);
});
