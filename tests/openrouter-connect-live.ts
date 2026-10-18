import assert from 'node:assert/strict';
import { call, devSplitEnv, handoffToken, signInAtInstance, signInAtRoot } from './lib/dev-split-session.js';

const step = (message: string) => console.log(`\n▶ ${message}`);

interface Provider { provider: string; modelCount: number; hasKey: boolean }

async function main(): Promise<void> {
  const { root, instance } = await devSplitEnv();
  const instanceUrl = instance.PUBLIC_URL!;

  step('signed in on the instance through root');
  const { token } = await handoffToken(root.PUBLIC_URL!, await signInAtRoot(root.PUBLIC_URL!));
  const signedIn = await signInAtInstance(instanceUrl, token);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const session = signedIn.cookie!;
  const openRouterNow = async () => ((await call(`${instanceUrl}/api/credentials/llm`, { cookie: session })).body as { providers: Provider[] }).providers.find((one) => one.provider === 'openrouter')!;
  const before = await openRouterNow();
  console.log(`  OpenRouter now: ${before.modelCount} models, ${before.hasKey ? 'with' : 'without'} a key`);

  step('Connect OpenRouter sends the person to OpenRouter\'s own sign-in, with a challenge and a state');
  const connect = await call(`${instanceUrl}/api/credentials/llm/openrouter/connect`, { cookie: session });
  assert.equal(connect.status, 302, JSON.stringify(connect.body));
  const auth = new URL(connect.location!);
  assert.equal(`${auth.origin}${auth.pathname}`, 'https://openrouter.ai/auth');
  assert.equal(auth.searchParams.get('callback_url'), `${instanceUrl}/api/credentials/llm/openrouter/callback`);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const state = auth.searchParams.get('state')!;
  const pending = connect.cookies.map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('openrouter_connect='));
  assert.ok(pending, 'no sealed connection cookie');
  const page = await fetch(auth, { redirect: 'follow' });
  assert.equal(page.status, 200, `OpenRouter's sign-in answered ${page.status}`);
  console.log(`  ${auth.origin}${auth.pathname} answers, calling back to ${auth.searchParams.get('callback_url')}`);

  const both = `${session}; ${pending}`;
  const back = async (query: string) => {
    const answer = await call(`${instanceUrl}/api/credentials/llm/openrouter/callback?${query}`, { cookie: both });
    assert.equal(answer.status, 302, JSON.stringify(answer.body));
    const where = new URL(answer.location!);
    assert.equal(where.hash, '#/studio/models');
    return where.searchParams;
  };

  step('a callback with a state Koala did not make is refused before OpenRouter is asked');
  assert.match((await back('code=made-up&state=not-it')).get('openrouterError') ?? '', /does not match/);

  step('OpenRouter itself refuses a code it never issued, and the person is told in plain words');
  const refused = (await back(`code=made-up-${Date.now()}&state=${encodeURIComponent(state)}`)).get('openrouterError') ?? '';
  assert.match(refused, /did not accept the connection/, refused);
  console.log(`  ${refused}`);

  step('nothing about the person\'s OpenRouter changed');
  assert.deepEqual(await openRouterNow(), before);

  console.log('\nopenrouter connect live — PASS (approving on OpenRouter is the person\'s own step)');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
