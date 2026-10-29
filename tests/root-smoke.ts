import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { certificateProblem, headerProblems, mailRecordProblems, portProblems, SCANNED_PORTS, summary, unknownName, type SmokeResult } from './lib/root-smoke.js';

const [rootDomain, peopleDomain] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const SSH_PUBLIC = process.argv.includes('--ssh-public');

const results: SmokeResult[] = [];
const report = (check: string, found: string, problem?: string) => {
  results.push({ check, found, problem });
  console.log(`${problem ? '✗' : '✓'} ${check}: ${problem ?? found}`);
};

async function attempt(check: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    report(check, '', (err as Error).message);
  }
}

function peerCertificate(host: string): Promise<{ validTo: Date; authorized: boolean; error?: string; names: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      resolve({ validTo: new Date(cert.valid_to), authorized: socket.authorized, error: socket.authorizationError?.toString(), names: cert.subjectaltname ?? '' });
      socket.end();
    });
    socket.on('error', reject);
  });
}

function answers(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: ip, port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(3000, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

const txt = async (name: string): Promise<string[][]> => dns.resolveTxt(name).catch(() => []);

async function main(): Promise<void> {
  if (!rootDomain || !peopleDomain) throw new Error('usage: npm run test:root-smoke -- <root domain> <people domain> [--ssh-public]');
  const app = `app.${rootDomain}`;
  const mesh = `mesh.${rootDomain}`;
  console.log(`smoke test of root at ${app}, people's addresses under ${peopleDomain}; read-only\n`);

  const [ip] = await dns.resolve4(app);
  if (!ip) throw new Error(`${app} resolves to nothing`);
  report('root resolves', `${app} is ${ip}`);

  await attempt('certificate', async () => {
    const cert = await peerCertificate(app);
    const days = Math.floor((cert.validTo.getTime() - Date.now()) / 86_400_000);
    report('certificate', `${app}: ${days} days left (${cert.names})`, certificateProblem(cert.validTo, cert.authorized, cert.error, new Date()));
  });

  await attempt('sign-in page', async () => {
    const page = await fetch(`https://${app}/`, { redirect: 'manual' });
    const body = await page.text();
    report('sign-in page', `${page.status}, ${body.length} bytes of HTML`, page.status === 200 && /<html/i.test(body) ? undefined : `https://${app}/ answered ${page.status}`);
    const problems = headerProblems(Object.fromEntries(page.headers.entries()));
    report('security headers', 'Content-Security-Policy, Strict-Transport-Security and nosniff are set', problems.length ? problems.join('; ') : undefined);
  });

  await attempt('identity keys', async () => {
    const keys = await fetch(`https://${app}/api/identity/keys`);
    const body = await keys.json().catch(() => undefined) as unknown;
    report('identity keys', `${keys.status}, root publishes its signing keys`, keys.status === 200 && body ? undefined : `/api/identity/keys answered ${keys.status}`);
  });

  await attempt('metrics guarded', async () => {
    const metrics = await fetch(`https://${app}/api/metrics`);
    report('metrics guarded', `${metrics.status} without a token`, metrics.status === 200 ? '/api/metrics answered without its token' : undefined);
  });

  await attempt('mesh', async () => {
    const health = await fetch(`https://${mesh}/health`);
    report('mesh', `https://${mesh}/health answered ${health.status}`, health.status === 200 ? undefined : `Headscale's health answered ${health.status}`);
  });

  await attempt('people wildcard', async () => {
    const name = unknownName(peopleDomain, randomBytes(6).toString('hex'));
    const [wildIp] = await dns.resolve4(name).catch(() => [] as string[]);
    if (wildIp !== ip) {
      report('people wildcard', '', `${name} resolves to ${wildIp ?? 'nothing'}, not root's ${ip}`);
      return;
    }
    const cert = await peerCertificate(name);
    const answer = await fetch(`https://${name}/`, { redirect: 'manual' });
    const problem = certificateProblem(cert.validTo, cert.authorized, cert.error, new Date()) ?? (answer.status === 404 ? undefined : `an unknown name answered ${answer.status}, not root's 404`);
    report('people wildcard', `${name} resolves to root, its certificate is trusted, and it answers 404`, problem);
  });

  await attempt('mail records', async () => {
    const seen = {
      domain: rootDomain,
      ip,
      mailHostA: await dns.resolve4(`mail.${rootDomain}`).catch(() => [] as string[]),
      domainTxt: await txt(rootDomain),
      dkimTxt: await txt(`koala._domainkey.${rootDomain}`),
      dmarcTxt: await txt(`_dmarc.${rootDomain}`),
    };
    const problems = mailRecordProblems(seen);
    report('mail records', `mail.${rootDomain}, SPF, DKIM (selector koala) and DMARC are as mail-dns.ts publishes them`, problems.length ? problems.join('; ') : undefined);
  });

  await attempt('open ports', async () => {
    const open: number[] = [];
    for (const port of SCANNED_PORTS) if (await answers(ip, port)) open.push(port);
    const problems = portProblems(open, SSH_PUBLIC);
    report('open ports', `of ${SCANNED_PORTS.length} common ports, ${open.join(', ') || 'none'} answer${SSH_PUBLIC ? ' (SSH may be public)' : ' (SSH only over the mesh)'}`, problems.length ? problems.join('; ') : undefined);
  });

  const { failed } = summary(results);
  console.log(failed ? `\nroot smoke — FAIL: ${failed} of ${results.length} checks` : `\nroot smoke — PASS: ${results.length} checks`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nroot smoke — FAIL: ${(err as Error).message}`);
  process.exit(1);
});
