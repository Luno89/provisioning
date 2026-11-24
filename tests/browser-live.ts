import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { startModelStandIn, type ModelStandIn } from './lib/model-stand-in.js';
import { nothingWentWrong, reached, seen, watched, type Ended, type Watched } from './lib/watched-page.js';
import { containerNotRunning } from './lib/dead-states.js';
import { startSplitStack, type SplitStack } from './lib/split-stack.js';

const step = (message: string) => console.log(`\n▶ ${message}`);

const stackDown = (stack: SplitStack): Ended => async () =>
  (await containerNotRunning(stack.names.containers.root)) || (await containerNotRunning(stack.names.containers.instance)) || undefined;

async function signsIn(stack: SplitStack, watching: Watched): Promise<void> {
  step('the owner signs in on root\'s page with their password and lands on their instance, signed in');
  const { page } = watching;
  const down = stackDown(stack);
  const refused: Ended = async () => (await down()) ?? ((await page.getByText(/^Koala could not sign you in/).first().isVisible()) ? (await page.getByText(/^Koala could not sign you in/).first().innerText()) : undefined);
  await page.goto(stack.rootUrl);
  await (await seen(watching, 'root\'s sign-in form', page.getByLabel('Email Address'), down)).fill(stack.owner.email);
  await page.getByLabel('Password').fill(stack.owner.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await reached(watching, 'the instance', (url) => url.origin === new URL(stack.instanceUrl).origin, refused);
  await seen(watching, 'the instance asking first for a model', page.getByRole('heading', { name: 'Give Koala a model to think with' }), refused);
  console.log(`  on ${new URL(page.url()).origin}, asked first for a model to think with`);
  nothingWentWrong(watching, 'signing in');
}

const ANSWER = 'The stand-in heard you and answers through the engine.';

async function chats(stack: SplitStack, watching: Watched, model: ModelStandIn): Promise<void> {
  step('the owner gives Koala a model through Studio → Models, makes it the default, and Koala answers in a chat');
  const { page } = watching;
  const down = stackDown(stack);
  await (await seen(watching, 'the way to paste a key', page.getByRole('link', { name: 'Or paste a key for any OpenAI-compatible provider' }), down)).click();
  const custom = page.getByTestId('model-provider').filter({ hasText: 'Custom Endpoint' });
  await (await seen(watching, 'the custom endpoint\'s Connect', custom.getByRole('button', { name: 'Connect' }), down)).click();
  await (await seen(watching, 'the custom endpoint\'s Base URL', custom.getByLabel('Base URL'), down)).fill(model.baseUrl);
  await custom.getByLabel('Model Name').fill(model.model);
  await custom.getByRole('button', { name: 'Connect and fetch models' }).click();
  await (await seen(watching, 'the fetched models\' filter', page.getByLabel('Filter models').first(), down)).fill(model.model);
  await (await seen(watching, `${model.model} among the models`, page.getByRole('button', { name: new RegExp(model.model) }), down)).click();
  await seen(watching, `${model.model} as the default`, page.getByText(/^Currently:/).filter({ hasText: model.model }), down);
  console.log(`  ${model.model} at ${model.baseUrl} is the default`);

  await page.goto(`${new URL(page.url()).origin}/#/chat`);
  await (await seen(watching, 'the chat\'s message box', page.getByPlaceholder(/^Message/), down)).fill('Are you there, Koala?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await seen(watching, 'Koala\'s answer', page.getByText(ANSWER), down);
  assert.ok(model.asked.some((text) => text.includes('Are you there, Koala?')), `the model was asked ${JSON.stringify(model.asked)}`);
  console.log('  the answer streamed back from the model through the engine');
  nothingWentWrong(watching, 'chatting');
}

async function seesInfrastructure(stack: SplitStack, watching: Watched): Promise<void> {
  step('Infrastructure shows every section and what needs attention, asking nothing that fails');
  const { page } = watching;
  const down = stackDown(stack);
  await (await seen(watching, 'Infrastructure in the sidebar', page.getByRole('button', { name: 'Infrastructure' }), down)).click();
  await seen(watching, 'the Infrastructure overview', page.getByTestId('infrastructure-overview'), down);
  await seen(watching, 'the dependencies checked', page.getByText(/^checked /), down);
  for (const title of ['Needs attention', 'Model traffic', 'Alerts set', 'Alert history']) {
    await seen(watching, `the ${title} section`, page.getByText(title, { exact: true }), down);
  }
  assert.equal(await page.getByText('Your own hardware', { exact: true }).count(), 0, 'the instance shows the mesh only root has');
  console.log('  every section rendered, and none of the mesh that only root has');
  nothingWentWrong(watching, 'Infrastructure');
}

async function settingsThenSignsOut(stack: SplitStack, watching: Watched): Promise<void> {
  step('Settings shows the account and the instance\'s own settings, and logging out ends the session');
  const { page } = watching;
  const down = stackDown(stack);
  const instance = new URL(stack.instanceUrl).origin;
  const root = new URL(stack.rootUrl).origin;
  await (await seen(watching, 'Settings in the sidebar', page.getByRole('button', { name: 'Settings' }), down)).click();
  await seen(watching, 'the Settings page', page.getByRole('heading', { name: 'Settings' }), down);
  await seen(watching, 'the account\'s email', page.getByText(stack.owner.email), down);
  for (const section of ['Updates', 'Notifications']) await seen(watching, `the ${section} section`, page.getByText(section, { exact: true }), down);
  console.log('  the account, its updates and notifications');
  nothingWentWrong(watching, 'Settings');

  const before = watching.navigations ?? 0;
  const signedBackIn: Ended = async () => (await down()) ?? (
    (watching.navigations ?? 0) > before && new URL(page.url()).origin === instance && await page.getByRole('button', { name: 'Log Out' }).isVisible()
      ? `the browser is back on the instance at ${page.url()}, signed in again without a password`
      : undefined);
  await page.getByRole('button', { name: 'Log Out' }).click();
  await seen(watching, 'root asking for the password again, or saying this browser is signed out', page.getByLabel('Password').or(page.getByText('This browser is signed out of Koala.')), signedBackIn);
  assert.equal(new URL(page.url()).origin, root, `the browser ended at ${page.url()}, not on root`);
  const me = await page.request.get(`${instance}/api/auth/me`);
  assert.equal(me.status(), 401, 'the instance still took the browser\'s session after logging out');
  console.log(`  signed out: the instance answers 401, and the browser is on root at ${page.url()}, signed out`);
}

async function main(): Promise<void> {
  step('a root and an instance with its engine worker start in containers from this commit\'s image');
  const stack = await startSplitStack({ engine: true });
  console.log(`  root ${stack.rootUrl}, instance ${stack.instanceUrl}`);
  const model = await startModelStandIn(ANSWER);
  const browser = await chromium.launch();
  let watching: Watched | undefined;
  try {
    const context = await browser.newContext();
    watching = await watched(context);
    await signsIn(stack, watching);
    await chats(stack, watching, model);
    await seesInfrastructure(stack, watching);
    await settingsThenSignsOut(stack, watching);
  } catch (err) {
    if (watching) {
      const shot = `${process.env.BROWSER_LIVE_SHOTS ?? '/tmp'}/browser-live-${Date.now()}.png`;
      await watching.page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      console.error(`\n── the page at ${watching.page.url()} (screenshot ${shot}) ──\n${(await watching.page.locator('body').innerText().catch(() => '')).slice(0, 2000)}`);
      console.error(`── what the page reported ──\n${watching.problems.join('\n')}`);
    }
    for (const side of ['root', 'instance'] as const) console.error(`\n── ${side}'s last lines ──\n${await stack.logs(side, 40)}`);
    throw err;
  } finally {
    await browser.close();
    await model.close();
    await stack.stop();
  }
  console.log('\nbrowser live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
