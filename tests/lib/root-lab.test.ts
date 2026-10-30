import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dropEnvValues } from '../../scripts/root-node/root-env.js';

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

const lab = (certificates: string, rootTls: string, domain: string) =>
  spawnSync('bash', [join(ROOT_NODE, 'lab.sh'), certificates, rootTls, domain], { encoding: 'utf8' });

describe('whether a root is a lab', () => {
  it('is a lab only when its settings say so and its domain is one nothing public resolves', () => {
    expect(lab('internal', '', 'koala.internal').stdout.trim()).toBe('1');
    expect(lab('', 'internal', 'koala.internal').stdout.trim()).toBe('1');
    expect(lab('acme', '', 'nowrinkles.dev').stdout.trim()).toBe('0');
    expect(lab('', '', 'nowrinkles.dev').stdout.trim()).toBe('0');
  });

  it('refuses lab settings left on a real domain, the leftover of a former lab bootstrapped again for real', () => {
    for (const [certificates, rootTls] of [['internal', ''], ['', 'internal'], ['acme', 'internal']] as const) {
      const said = lab(certificates, rootTls, 'nowrinkles.dev');
      expect(said.status, `${certificates} ${rootTls}`).toBe(1);
      expect(said.stdout).toBe('');
      expect(said.stderr).toMatch(/a lab, but DOMAIN is nowrinkles\.dev, a real domain\. .* On a real root set CERTIFICATES=acme and remove ROOT_TLS=internal from \.env, then run this again\. Nothing was changed\./);
    }
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
    const repo = rootWith('DOMAIN=nowrinkles.dev\nCERTIFICATES=acme\nROOT_TLS=internal\n');
    const ran = spawnSync('bash', [join(ROOT_NODE, 'update.sh'), 'v2026.10.30'], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs({})}:${process.env.PATH}`, REPO_DIR: repo } });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/This root's settings say ROOT_TLS=internal, a lab, but DOMAIN is nowrinkles\.dev, a real domain\./);
    expect(ran.stdout).not.toMatch(/▶/);
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('DOMAIN=nowrinkles.dev\nCERTIFICATES=acme\nROOT_TLS=internal\n');
  });
});

describe('bootstrap.sh asked for a lab', () => {
  it('refuses on a real domain before it installs anything', () => {
    for (const env of [{ CERTIFICATES: 'internal', DOMAIN: 'nowrinkles.dev' }, { ROOT_TLS: 'internal' }]) {
      const ran = spawnSync('bash', [join(ROOT_NODE, 'bootstrap.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs({})}:${process.env.PATH}`, REPO_DIR: scratch('root-lab-none-'), ...env } });
      expect(ran.status, JSON.stringify(env)).toBe(1);
      expect(ran.stdout).toMatch(/This root's settings say CERTIFICATES=internal, a lab, but DOMAIN is nowrinkles\.dev, a real domain\./);
      expect(ran.stdout).not.toMatch(/Bootstrapping/);
    }
  });
});

describe('the hourly release watch', () => {
  function rootOn(latest: string): { repo: string; stub: string } {
    const repo = scratch('root-lab-watch-');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/luno89/nowrinkles.git');
    mkdirSync(join(repo, 'scripts/root-node'), { recursive: true });
    writeFileSync(join(repo, 'scripts/root-node/update.sh'), 'echo "update.sh moved root onto $1"\n');
    for (const name of ['cdktf-bindings.sh', 'verify-release.sh', 'lab.sh']) writeFileSync(join(repo, 'scripts/root-node', name), '');
    git('add', '-A');
    git('commit', '-qm', 'running');
    git('tag', '-a', 'v2026.10.29', '-m', 'v2026.10.29\n\nShipped and released from aaaaaaaaaaaa after v2026.10.28: release-live.');
    git('commit', '-qm', 'gated', '--allow-empty');
    git('tag', '-a', 'v2026.10.30', '-m', 'v2026.10.30\n\nShipped and released from bbbbbbbbbbbb after v2026.10.29: release-live.');
    git('commit', '-qm', 'fixed', '--allow-empty');
    git('tag', '-a', 'v2026.10.30-2', '-m', 'v2026.10.30-2\n\nHotfix released from cccccccccccc after v2026.10.30 without the gates: typecheck and the image build.');
    git('checkout', '-q', 'v2026.10.29');
    const stub = stubs({ curl: `#!/usr/bin/env bash\necho '{"tag_name":"${latest}"}'\n` });
    return { repo, stub };
  }

  const watch = (root: { repo: string; stub: string }, ...args: string[]) =>
    spawnSync('bash', [join(ROOT_NODE, 'release-watch.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${root.stub}:${process.env.PATH}`, REPO_DIR: root.repo } });

  it('moves root onto a newer release made through the gates', () => {
    const moved = watch(rootOn('v2026.10.30'));
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain('update.sh moved root onto v2026.10.30');
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

describe('root\'s .env', () => {
  it('loses a key outright, keeping every other line', () => {
    const file = join(scratch('root-lab-env-'), '.env');
    writeFileSync(file, 'DOMAIN=nowrinkles.dev\nROOT_TLS=internal\nCERTIFICATES=acme\n');
    dropEnvValues(file, ['ROOT_TLS']);
    expect(readFileSync(file, 'utf8')).toBe('DOMAIN=nowrinkles.dev\nCERTIFICATES=acme\n');
  });
});
