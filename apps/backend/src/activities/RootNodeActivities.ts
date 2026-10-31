import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApplicationFailure } from '@temporalio/common';
import { claimSettingsFrom, createDatabase, loadKeys, roleFromEnv, type Database } from '../platform/index.js';
import {
  bootstrapScript, CredentialService, generateSshKeypair, KOALA_REPOSITORY, missingFromEnvFile, READY_MARK, readOverSsh, redacted,
  runScriptOverSsh, ServerOrderProblem, ServerOrderService, setupCodeFrom, signInSecretsOf, sshAnswers,
} from '../infrastructure/index.js';

const execFileAsync = promisify(execFile);

async function withOrders<T>(work: (orders: ServerOrderService) => Promise<T>): Promise<T> {
  const db: Database = createDatabase();
  await db.init();
  try {
    const keys = loadKeys(process.env);
    const credentials = new CredentialService(db, keys.data, claimSettingsFrom(roleFromEnv(process.env)));
    const orders = new ServerOrderService({
      store: db.infrastructure,
      dataKey: keys.data,
      ovhAccountOf: async (ownerId) => {
        const resolved = await credentials.resolveCredentials(ownerId, 'ovh');
        if (resolved.mode === 'mock') return undefined;
        const { OVH_APPLICATION_KEY: applicationKey, OVH_APPLICATION_SECRET: applicationSecret, OVH_CONSUMER_KEY: consumerKey, OVH_SUBSIDIARY: subsidiary } = resolved.env;
        return applicationKey && applicationSecret && consumerKey ? { applicationKey, applicationSecret, consumerKey, subsidiary: subsidiary || 'FR' } : undefined;
      },
      dnsCredentialsOf: (ownerId, provider) => credentials.dnsCredentialsOf(ownerId, provider),
      lsRemote: async () => (await execFileAsync('git', ['ls-remote', '--tags', KOALA_REPOSITORY], { maxBuffer: 16 * 1024 * 1024 })).stdout,
    });
    return await work(orders);
  } finally {
    await db.close();
  }
}

const final = (error: unknown): never => {
  if (error instanceof ServerOrderProblem) throw ApplicationFailure.nonRetryable(error.message, 'ServerOrderProblem');
  throw error;
};

export async function ServerOrderFollowActivity(orderId: string): Promise<{ delivered: boolean }> {
  return withOrders((orders) => orders.follow(orderId)).catch(final);
}

export async function ServerOrderRebuildActivity(orderId: string): Promise<{ ip: string }> {
  return withOrders(async (orders) => {
    const order = await orders.order(orderId);
    if (order.ip && order.sshPrivateKey) return { ip: order.ip };
    const keypair = await generateSshKeypair(`koala-root-${orderId.slice(0, 8)}`);
    await orders.mark(orderId, 'installing-key');
    return orders.rebuild(orderId, keypair);
  }).catch(final);
}

export async function ServerOrderSshActivity(orderId: string): Promise<boolean> {
  return withOrders(async (orders) => {
    const order = await orders.order(orderId);
    if (!order.ip) throw new Error('the server has no address yet');
    return sshAnswers({ host: order.ip, privateKey: orders.privateKeyOf(order) });
  }).catch(final);
}

export async function ServerOrderDnsActivity(orderId: string): Promise<boolean> {
  return withOrders(async (orders) => (await orders.pointDomains(orderId)).done).catch(final);
}

export async function ServerOrderReleaseActivity(orderId: string): Promise<string | undefined> {
  return withOrders((orders) => orders.releaseToInstall(orderId)).catch(final);
}

const SETUP_CODE_SHAPE = /\b[0-9a-f]{32}\b/g;

export async function ServerOrderBootstrapActivity(orderId: string, release: string): Promise<void> {
  return withOrders(async (orders) => {
    const order = await orders.order(orderId);
    if (!order.ip) throw new Error('the server has no address yet');
    const dns = await orders.dnsFor(orderId);
    const signInEnv = await orders.signInFor(orderId);
    const secrets = [...Object.values(dns.env), ...signInSecretsOf(signInEnv)];
    const target = { host: order.ip, privateKey: orders.privateKeyOf(order) };
    await orders.mark(orderId, 'bootstrapping', `Installing Koala's root (${release}) on ${order.ip}`, { release });
    let buffered: string[] = [];
    let readyMarked = false;
    const flush = async () => {
      const lines = buffered;
      buffered = [];
      await orders.log(orderId, lines);
    };
    let flushing = Promise.resolve();
    const code = await runScriptOverSsh(target, bootstrapScript({ release, domain: order.domain, ingressDomain: order.ingressDomain, acmeEmail: order.acmeEmail, domainDns: dns.domainDns, ingressDns: dns.ingressDns, dnsEnv: dns.env, signInEnv }), (line) => {
      if (line.includes(READY_MARK)) { readyMarked = true; return; }
      buffered.push(redacted(line, secrets).replace(SETUP_CODE_SHAPE, '••••'));
      if (buffered.length >= 20) flushing = flushing.then(flush);
    });
    await flushing;
    await flush();
    if (code !== 0 || !readyMarked) throw ApplicationFailure.nonRetryable(`Installing root ended with ${code}; the log above says where. Fix it on the server or in its DNS, then retry from the order.`, 'BootstrapFailed');
    const setupCode = setupCodeFrom(await readOverSsh(target, "grep '^ADMIN_SETUP_CODE=' /opt/nowrinkles/apps/backend/.env"));
    if (Object.keys(signInEnv).length) {
      const missing = missingFromEnvFile(await readOverSsh(target, "grep -oE '^[A-Z][A-Z0-9_]*=' /opt/nowrinkles/apps/backend/.env"), signInEnv);
      await orders.log(orderId, [missing.length
        ? `${release} did not write ${missing.join(', ')} into root's .env, so root offers passwords only until they are added there by hand and nowrinkles.service is restarted (docs/runbook.md, Sign-in providers)`
        : `root offers sign-in with ${(order.signIn ?? []).map((provider) => provider.label).join(', ')} beside passwords`]);
    }
    await orders.ready(orderId, setupCode, release);
  }).catch(final);
}

export async function ServerOrderReverseDnsActivity(orderId: string): Promise<boolean> {
  return withOrders(async (orders) => (await orders.setReverseDns(orderId)).done).catch(final);
}

export async function ServerOrderMailCheckActivity(orderId: string): Promise<void> {
  return withOrders(async (orders) => {
    const order = await orders.order(orderId);
    if (!order.ip) throw new Error('the server has no address yet');
    const lines: string[] = [];
    const quoted = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const script = `[ -f /opt/nowrinkles/scripts/root-node/mail-check.ts ] || exit 3\ncd /opt/nowrinkles && npx tsx scripts/root-node/mail-check.ts ${quoted(order.domain)} --ip ${quoted(order.ip)} --json`;
    const code = await runScriptOverSsh({ host: order.ip, privateKey: orders.privateKeyOf(order) }, script, (line) => lines.push(line));
    await orders.recordMailCheck(orderId, code === 3 ? undefined : lines.join('\n'));
  }).catch(final);
}

export async function ServerOrderStoppedActivity(orderId: string): Promise<void> {
  return withOrders((orders) => orders.stopped(orderId));
}

export async function ServerOrderFailedActivity(orderId: string, reason: string): Promise<void> {
  return withOrders((orders) => orders.failed(orderId, reason));
}
