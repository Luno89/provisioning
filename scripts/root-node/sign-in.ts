import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  providerCallbackUrl, SIGN_IN_PROVIDERS, signInEnvNames, signInFieldsOf, signInProvidersFrom,
} from '../../apps/backend/src/accounts/lib/sign-in-providers.js';
import { envValueProblem } from '../../apps/backend/src/infrastructure/lib/root-sign-in.js';
import { dotenvValue, readEnvFile, setEnvValues } from './root-env.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const BACKEND_ENV = process.env.BACKEND_ENV ?? join(REPO, 'apps/backend/.env');

const fail = (message: string): never => {
  console.error(`  ❌ ${message}`);
  process.exit(1);
};

function setup(): void {
  const given: Record<string, string> = {};
  for (const name of signInEnvNames()) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    const wrong = envValueProblem(name, value);
    if (wrong) fail(`${wrong}. Nothing was written to ${BACKEND_ENV}.`);
    given[name] = value;
  }
  const { providers, problems } = signInProvidersFrom({ ...readEnvFile(BACKEND_ENV), ...given });
  if (problems.length) fail(`${problems.join('; ')}. Nothing was written to ${BACKEND_ENV}.`);
  if (Object.keys(given).length) setEnvValues(BACKEND_ENV, Object.fromEntries(Object.entries(given).map(([name, value]) => [name, dotenvValue(value)])));
  const publicUrl = process.env.PUBLIC_URL ?? 'https://app.<DOMAIN>';
  for (const description of SIGN_IN_PROVIDERS) {
    const on = providers.find((provider) => provider.id === description.id);
    const redirect = providerCallbackUrl(publicUrl, description.id);
    if (on) {
      console.log(`  ✅ ${on.label} sign-in is on${Object.keys(given).some((name) => signInFieldsOf(description).some((field) => field.env === name)) ? ' (written now)' : ' (kept)'}; its redirect URI is ${redirect}`);
      continue;
    }
    const names = signInFieldsOf(description).filter((field) => !field.optional).map((field) => field.env).join(', ');
    console.log(`  ·  ${description.label} sign-in is off. To offer it: register ${redirect} as its redirect URI${description.register.url ? ` at ${description.register.url}` : ''}, set ${names} in ${BACKEND_ENV}, then systemctl restart nowrinkles`);
  }
  if (!providers.length) console.log('  ✅ people sign in with passwords; every sign-in provider is optional');
}

const command = process.argv[2];
if (command === 'setup') {
  try {
    setup();
  } catch (error) {
    fail((error as Error).message);
  }
} else {
  console.error('usage: tsx scripts/root-node/sign-in.ts setup');
  process.exit(2);
}
