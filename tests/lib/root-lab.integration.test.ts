import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tagMessage } from './gates.js';
import { spawnScript } from '../coupling/shell-trace.js';

const ROOT_NODE = new URL('../../scripts/root-node/', import.meta.url).pathname;
const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubs(scripts: Record<string, string>): string {
  const dir = scratch('root-lab-stubs-');
  for (const [name, body] of Object.entries({ id: '#!/usr/bin/env bash\necho 0\n', ...scripts })) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

const lab = (certificates: string, domain: string) =>
  spawnScript(join(ROOT_NODE, 'lab.sh'), [certificates, domain], { encoding: 'utf8' });

describe('whether a root is a lab', () => {
  it('is a lab only when its settings say so and its domain is one nothing public resolves', () => {
    expect(lab('internal', 'koala.internal').stdout.trim()).toBe('1');
    expect(lab('acme', 'koala.internal').stdout.trim()).toBe('0');
    expect(lab('acme', 'nowrinkles.dev').stdout.trim()).toBe('0');
    expect(lab('', 'nowrinkles.dev').stdout.trim()).toBe('0');
  });

  it('refuses lab settings left on a real domain, the leftover of a former lab bootstrapped again for real', () => {
    const said = lab('internal', 'nowrinkles.dev');
    expect(said.status).toBe(1);
    expect(said.stdout).toBe('');
    expect(said.stderr).toMatch(/a lab, but DOMAIN is nowrinkles\.dev, a real domain\. .* On a real root set CERTIFICATES=acme in \.env, then run this again\. Nothing was changed\./);
  });
});

describe('an older root\'s ROOT_TLS', () => {
  const renamed = (env: string) => {
    const file = join(scratch('root-tls-'), '.env');
    writeFileSync(file, env);
    const ran = spawnScript(join(ROOT_NODE, 'root-tls.sh'), [file], { encoding: 'utf8' });
    return { ...ran, env: readFileSync(file, 'utf8') };
  };

  it('becomes the settings it meant, once, and is gone', () => {
    const lab = renamed('DOMAIN=koala.internal\nROOT_TLS=internal\nCERTIFICATES=internal\n');
    expect(lab.status).toBe(0);
    expect(lab.env).toBe('DOMAIN=koala.internal\nCERTIFICATES=internal\n');
    const older = renamed('DOMAIN=koala.internal\nROOT_TLS=internal');
    expect(older.env).toBe('DOMAIN=koala.internal\nCERTIFICATES=internal\n');
    expect(older.stdout).toContain('ROOT_TLS=internal in ');
    const cloudflare = renamed('DOMAIN=nowrinkles.dev\nROOT_TLS=cloudflare\nCLOUDFLARE_API_TOKEN=t\n');
    expect(cloudflare.env).toBe('DOMAIN=nowrinkles.dev\nCLOUDFLARE_API_TOKEN=t\nCERTIFICATES=acme\nDOMAIN_DNS=cloudflare\nINGRESS_DNS=cloudflare\n');
    const again = spawnScript(join(ROOT_NODE, 'root-tls.sh'), [join(scratch('root-tls-none-'), '.env')], { encoding: 'utf8' });
    expect([again.status, again.stdout]).toEqual([0, '']);
  });

  it('never overrides what the settings beside it say, since every release read those first', () => {
    expect(renamed('CERTIFICATES=acme\nDOMAIN_DNS=porkbun\nROOT_TLS=cloudflare\n').env).toBe('CERTIFICATES=acme\nDOMAIN_DNS=porkbun\nINGRESS_DNS=cloudflare\n');
    expect(renamed('CERTIFICATES=acme\nROOT_TLS=internal\n').env).toBe('CERTIFICATES=acme\n');
    expect(renamed('DOMAIN=nowrinkles.dev\nROOT_TLS=\n').env).toBe('DOMAIN=nowrinkles.dev\n');
  });

  it('is rewritten by dns.ts setup too, which every release from here runs, whichever update.sh moved root onto it', () => {
    const dir = scratch('root-tls-dns-');
    const file = join(dir, '.env');
    writeFileSync(file, 'DOMAIN=koala.internal\nINGRESS_DOMAIN=koala.internal\nROOT_TLS=internal\n');
    const said = execFileSync('npx', ['tsx', join(ROOT_NODE, 'dns.ts'), 'setup'], { encoding: 'utf8', env: { ...process.env, COMPOSE_ENV: file, KOALA_CADDY_DIR: join(dir, 'caddy') } });
    expect(said).toContain('ROOT_TLS=internal in ');
    expect(readFileSync(file, 'utf8')).toBe('DOMAIN=koala.internal\nINGRESS_DOMAIN=koala.internal\nCERTIFICATES=internal\n');
    expect(readFileSync(join(dir, 'caddy', 'caddy-tls', 'koala.caddy'), 'utf8')).toBe('tls internal\n');
  });

  it('refuses a value no release read, changing nothing', () => {
    const odd = renamed('DOMAIN=nowrinkles.dev\nROOT_TLS=letsencrypt\n');
    expect(odd.status).toBe(1);
    expect(odd.stderr).toContain('ROOT_TLS in ');
    expect(odd.stderr).toContain('is letsencrypt, which no release of Koala read');
    expect(odd.env).toBe('DOMAIN=nowrinkles.dev\nROOT_TLS=letsencrypt\n');
  });
});

describe('update.sh on a root whose .env still says it is a lab', () => {
  function rootWith(env: string): string {
    const repo = scratch('root-lab-repo-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.env'), env);
    return repo;
  }

  it('refuses before it touches anything when the domain is real', () => {
    const repo = rootWith('DOMAIN=nowrinkles.dev\nCERTIFICATES=internal\n');
    const ran = spawnScript(join(ROOT_NODE, 'update.sh'), ['v2026.10.30'], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs({})}:${process.env.PATH}`, REPO_DIR: repo } });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/This root's settings say CERTIFICATES=internal, a lab, but DOMAIN is nowrinkles\.dev, a real domain\./);
    expect(ran.stdout).not.toMatch(/▶/);
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('DOMAIN=nowrinkles.dev\nCERTIFICATES=internal\n');
  });

  it('turns an older root\'s ROOT_TLS into CERTIFICATES before it decides whether the root is a lab', () => {
    const repo = rootWith('DOMAIN=nowrinkles.dev\nROOT_TLS=internal\n');
    const ran = spawnScript(join(ROOT_NODE, 'update.sh'), ['v2026.10.30'], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs({})}:${process.env.PATH}`, REPO_DIR: repo } });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('ROOT_TLS=internal in .env is now CERTIFICATES=internal');
    expect(ran.stdout).toMatch(/This root's settings say CERTIFICATES=internal, a lab, but DOMAIN is nowrinkles\.dev, a real domain\./);
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('DOMAIN=nowrinkles.dev\nCERTIFICATES=internal\n');
  });
});

describe('bootstrap.sh asked for a lab', () => {
  it('refuses on a real domain before it installs anything', () => {
    const ran = spawnScript(join(ROOT_NODE, 'bootstrap.sh'), [], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs({})}:${process.env.PATH}`, REPO_DIR: scratch('root-lab-none-'), CERTIFICATES: 'internal', DOMAIN: 'nowrinkles.dev' } });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/This root's settings say CERTIFICATES=internal, a lab, but DOMAIN is nowrinkles\.dev, a real domain\./);
    expect(ran.stdout).not.toMatch(/Bootstrapping/);
  });

  it('refuses ROOT_TLS, which it no longer reads, naming what to set instead', () => {
    const ran = spawnScript(join(ROOT_NODE, 'bootstrap.sh'), [], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs({})}:${process.env.PATH}`, REPO_DIR: scratch('root-lab-none-'), ROOT_TLS: 'internal', DOMAIN: 'koala.internal' } });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('ROOT_TLS is no longer read; set CERTIFICATES=internal (a lab) or CERTIFICATES=acme instead');
    expect(ran.stdout).not.toMatch(/Bootstrapping/);
  });
});

describe('the hourly release watch', () => {
  const ran = [{ name: 'the release rehearsal', script: 'test:release-live', minutes: 40 }];
  const github = (code: number, body: string) => `#!/usr/bin/env bash\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\nprintf '%s' '${body}' > "$out"\nprintf '${code}'\n`;

  function rootOn(latest: string, answer = github(200, `{"tag_name":"${latest}"}`)): { repo: string; stub: string } {
    const repo = scratch('root-lab-watch-');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/luno89/nowrinkles.git');
    mkdirSync(join(repo, 'scripts/root-node'), { recursive: true });
    writeFileSync(join(repo, 'scripts/root-node/update.sh'), 'echo "update.sh moved root onto $1"\n');
    for (const name of ['cdktf-bindings.sh', 'verify-release.sh', 'lab.sh', 'root-tls.sh']) writeFileSync(join(repo, 'scripts/root-node', name), '');
    git('add', '-A');
    git('commit', '-qm', 'running');
    git('tag', '-a', 'v2026.10.29', '-m', tagMessage('v2026.10.29', 'a'.repeat(40), 'v2026.10.28', ran, false));
    git('commit', '-qm', 'gated', '--allow-empty');
    git('tag', '-a', 'v2026.10.30', '-m', tagMessage('v2026.10.30', 'b'.repeat(40), 'v2026.10.29', ran, false));
    git('commit', '-qm', 'fixed', '--allow-empty');
    git('tag', '-a', 'v2026.10.30-2', '-m', tagMessage('v2026.10.30-2', 'c'.repeat(40), 'v2026.10.30', [], true));
    git('checkout', '-q', 'v2026.10.29');
    const stub = stubs({ curl: answer });
    return { repo, stub };
  }

  const watch = (root: { repo: string; stub: string }, ...args: string[]) =>
    spawnScript(join(ROOT_NODE, 'release-watch.sh'), args, { encoding: 'utf8', env: { ...process.env, PATH: `${root.stub}:${process.env.PATH}`, REPO_DIR: root.repo } });

  it('moves root onto a newer release made through the gates', () => {
    const moved = watch(rootOn('v2026.10.30'));
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain('update.sh moved root onto v2026.10.30');
  });

  it('waits quietly while nothing is published yet, and fails saying why when GitHub cannot be asked', () => {
    const none = watch(rootOn('', github(404, '{"message":"Not Found"}')));
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('found no published release of luno89/nowrinkles on GitHub');
    const limited = watch(rootOn('', github(403, '{"message":"API rate limit exceeded"}')));
    expect(limited.status).toBe(1);
    expect(limited.stderr).toContain('GitHub did not say which release of luno89/nowrinkles is newest (403): {"message":"API rate limit exceeded"}');
    expect(limited.stdout).not.toContain('update.sh moved root');
  });

  it('leaves a hotfix for the operator, and takes it when they name it', () => {
    const root = rootOn('v2026.10.30-2');
    const left = watch(root);
    expect(left.status).toBe(0);
    expect(left.stdout).toContain('v2026.10.30-2 is a hotfix, released without the gates; root moves onto it only when the operator names it');
    expect(left.stdout).not.toContain('update.sh moved root');
    const named = watch(root, 'v2026.10.30-2');
    expect(named.status).toBe(0);
    expect(named.stdout).toContain('update.sh moved root onto v2026.10.30-2');
  });
});
