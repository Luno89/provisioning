import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { authenticate } from 'mailauth';
import { MailService } from '../apps/backend/src/services/MailService.js';
import { alertMail } from '../apps/backend/src/lib/mail.js';
import { dkimValue } from '../apps/backend/src/lib/mail-dns.js';
import { emailWayFrom } from '../apps/backend/src/lib/email-way.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DOMAIN = 'koala.localhost';
const NETWORK = 'nw-mail-live';
const SMTP_PORT = 12525;
const PIT_PORT = 18025;
const CONTAINERS = { pit: 'nw-mail-live-pit', mail: 'nw-mail-live-mail' };
const MAILPIT = 'axllent/mailpit:v1.21.0';
const IMAGE = 'nowrinkles/mail:dev';
const TO = 'owner@example.com';

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const step = (message: string) => console.log(`\n▶ ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; ; tries += 1) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (tries > 0 && tries % 20 === 0) console.log(`  still waiting for ${what}`);
    await sleep(1000);
  }
}

function teardown(): void {
  for (const name of Object.values(CONTAINERS)) try { run('docker', ['rm', '-f', name]); } catch { /* not running */ }
  try { run('docker', ['network', 'rm', NETWORK]); } catch { /* not there */ }
}

async function main(): Promise<void> {
  step('the mail server is built and sends, signing as the platform\'s domain; a test mailbox stands in for the recipient\'s');
  teardown();
  run('docker', ['build', '-q', '-t', IMAGE, 'docker/mail']);
  run('docker', ['network', 'create', NETWORK]);
  run('docker', ['run', '-d', '--name', CONTAINERS.pit, '--network', NETWORK, '-p', `127.0.0.1:${PIT_PORT}:8025`, MAILPIT]);
  run('docker', ['run', '-d', '--name', CONTAINERS.mail, '--network', NETWORK, '-p', `127.0.0.1:${SMTP_PORT}:2525`,
    '-e', `MAIL_DOMAIN=${DOMAIN}`, '-e', 'MAIL_LISTEN=all', '-e', 'MAIL_TRUSTED=172.16.0.0/12 192.168.0.0/16 10.0.0.0/8',
    '-e', `MAIL_RELAYHOST=[${CONTAINERS.pit}]:1025`, IMAGE]);
  await until('the mail server', async () => (run('docker', ['logs', CONTAINERS.mail]).includes('daemon started') ? true : undefined));
  const dkim = dkimValue(run('docker', ['exec', CONTAINERS.mail, 'cat', '/var/lib/dkim/koala.txt']));
  console.log(`  its key: ${dkim.slice(0, 40)}…`);

  step('the backend\'s mailer sends an alert through it');
  const way = emailWayFrom({ MAIL_SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}`, INGRESS_DOMAIN: DOMAIN }, { role: 'root' });
  assert.equal(way.kind, 'smtp');
  const mail = new MailService({ way, emailOf: async () => TO });
  const message = alertMail({ id: 'e1', ownerId: 'o', clusterId: 'c', key: 'k', name: 'Koala_down', summary: 'books has not answered for 5 minutes', about: { kind: 'app', deploymentId: 'books' }, startedAt: new Date().toISOString() }, 'fired', `https://app.${DOMAIN}`);
  await mail.toOwner('o', message);

  step('it arrives, and its DKIM signature checks out against the key the DNS script publishes');
  const listed = await until('the message', async () => {
    const answer = await (await fetch(`http://127.0.0.1:${PIT_PORT}/api/v1/messages`)).json() as { messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }>; From: { Address: string } }> };
    return answer.messages.find((entry) => entry.Subject === message.subject);
  });
  assert.equal(listed.To[0]?.Address, TO);
  assert.equal(listed.From.Address, `alerts@${DOMAIN}`);
  const raw = await (await fetch(`http://127.0.0.1:${PIT_PORT}/api/v1/message/${listed.ID}/raw`)).text();
  const result = await authenticate(raw, {
    resolver: async (name: string, type: string) => {
      if (type === 'TXT' && name === `koala._domainkey.${DOMAIN}`) return [[dkim]];
      const error = new Error(`no ${type} ${name}`) as Error & { code: string };
      error.code = 'ENOTFOUND';
      throw error;
    },
    trustReceived: true,
  });
  const signature = result.dkim.results[0];
  console.log(`  dkim: ${signature?.status.result} for ${signature?.signingDomain}`);
  assert.equal(signature?.status.result, 'pass');
  assert.equal(signature?.signingDomain, DOMAIN);

  step('a message from somewhere it does not trust is refused');
  const refused = (() => {
    try {
      run('docker', ['run', '--rm', '--network', NETWORK, 'alpine:3.20', 'sh', '-c',
        `apk add -q --no-cache curl >/dev/null && printf 'Subject: relay\\r\\n\\r\\nx\\r\\n' > /m && curl -s --url smtp://${CONTAINERS.mail}:2525 --mail-from x@evil.example --mail-rcpt someone@example.com --upload-file /m`]);
      return false;
    } catch {
      return true;
    }
  });
  run('docker', ['rm', '-f', CONTAINERS.mail]);
  run('docker', ['run', '-d', '--name', CONTAINERS.mail, '--network', NETWORK, '-e', `MAIL_DOMAIN=${DOMAIN}`, '-e', 'MAIL_LISTEN=all', '-e', `MAIL_RELAYHOST=[${CONTAINERS.pit}]:1025`, IMAGE]);
  await until('the mail server, trusting only itself', async () => (run('docker', ['logs', CONTAINERS.mail]).includes('daemon started') ? true : undefined));
  assert.ok(refused(), 'the mail server relayed for a host it does not trust');
  const log = run('docker', ['logs', CONTAINERS.mail]);
  assert.match(log, /NOQUEUE: reject: RCPT from .*: 554 5\.7\.1 .*Access denied/, 'the refusal was not the mail server\'s own');
  console.log('  refused with 554 Access denied: it only sends for itself');

  console.log('\nmail live — PASS');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(teardown);
