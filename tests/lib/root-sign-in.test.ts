import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'dotenv';
import { signInEnvNames, signInProvidersFrom } from '../../apps/backend/src/accounts/lib/sign-in-providers.js';

const ROOT_NODE = new URL('../../scripts/root-node/', import.meta.url).pathname;
const TSX = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootEnv(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'root-sign-in-'));
  dirs.push(dir);
  const file = join(dir, '.env');
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !signInEnvNames().includes(name)));

const setup = (file: string, given: Record<string, string>) =>
  spawnSync(TSX, [join(ROOT_NODE, 'sign-in.ts'), 'setup'], { encoding: 'utf8', env: { ...cleanEnv(), BACKEND_ENV: file, PUBLIC_URL: 'https://app.nowrinkles.dev', ...given } });

describe('bootstrap.sh writing the sign-in providers into root\'s .env', () => {
  it('runs sign-in.ts setup on the backend\'s env, after PUBLIC_URL is set and before the backend\'s account takes the file', () => {
    const script = readFileSync(join(ROOT_NODE, 'bootstrap.sh'), 'utf8');
    const at = script.indexOf('BACKEND_ENV="$ENV_FILE" PUBLIC_URL="$PUBLIC_URL" npx tsx scripts/root-node/sign-in.ts setup || die');
    expect(at).toBeGreaterThan(script.indexOf('set_env PUBLIC_URL'));
    expect(at).toBeLessThan(script.indexOf('bash scripts/root-node/units.sh'));
  });

  it('writes what it is given, mode 600, so the backend reads every value back as it was given', { timeout: 30_000 }, () => {
    const file = rootEnv('NODE_ENV=production\nROLE=root\n');
    const ran = setup(file, {
      GOOGLE_CLIENT_ID: 'google-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-fake-a#b c',
      OIDC_ISSUER: 'https://login.example.com/realms/staff', OIDC_CLIENT_ID: 'koala', OIDC_CLIENT_SECRET: 'own-secret', OIDC_LABEL: 'Example staff',
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = parse(readFileSync(file, 'utf8'));
    expect(written).toMatchObject({ ROLE: 'root', GOOGLE_CLIENT_SECRET: 'google-fake-a#b c', OIDC_LABEL: 'Example staff', OIDC_CLIENT_SECRET: 'own-secret' });
    expect(signInProvidersFrom(written).providers.map((provider) => provider.label)).toEqual(['Google', 'Example staff']);
    expect(ran.stdout).toContain('Google sign-in is on (written now); its redirect URI is https://app.nowrinkles.dev/api/auth/provider/google/callback');
    expect(ran.stdout).toMatch(/GitHub sign-in is off\. To offer it: register https:\/\/app\.nowrinkles\.dev\/api\/auth\/provider\/github\/callback as its redirect URI at https:\/\/github\.com\/settings\/applications\/new, set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET in /);
    expect(ran.stdout + ran.stderr).not.toMatch(/google-fake|own-secret/);
  });

  it('keeps what an operator wrote by hand, changes only what it is given, and takes nothing as passwords only', { timeout: 30_000 }, () => {
    const file = rootEnv('ROLE=root\nGITHUB_CLIENT_ID=by-hand\nGITHUB_CLIENT_SECRET=by-hand-secret\n');
    expect(setup(file, {}).stdout).toContain('GitHub sign-in is on (kept)');
    expect(readFileSync(file, 'utf8')).toBe('ROLE=root\nGITHUB_CLIENT_ID=by-hand\nGITHUB_CLIENT_SECRET=by-hand-secret\n');
    expect(setup(file, { GITHUB_CLIENT_SECRET: 'rotated' }).status).toBe(0);
    expect(parse(readFileSync(file, 'utf8'))).toEqual({ ROLE: 'root', GITHUB_CLIENT_ID: 'by-hand', GITHUB_CLIENT_SECRET: 'rotated' });
    const none = rootEnv('ROLE=root\n');
    expect(setup(none, {}).stdout).toContain('people sign in with passwords');
    expect(readFileSync(none, 'utf8')).toBe('ROLE=root\n');
  });

  it('refuses a half-given provider or a value .env cannot hold, writing nothing', { timeout: 30_000 }, () => {
    const file = rootEnv('ROLE=root\n');
    const half = setup(file, { GOOGLE_CLIENT_ID: 'only-the-id' });
    expect(half.status).toBe(1);
    expect(half.stderr).toMatch(/Google sign-in is off: GOOGLE_CLIENT_SECRET is not set\. Nothing was written/);
    const quoted = setup(file, { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: "it's" });
    expect(quoted.status).toBe(1);
    expect(quoted.stderr).toMatch(/single quote/);
    expect(readFileSync(file, 'utf8')).toBe('ROLE=root\n');
  });
});
