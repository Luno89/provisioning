import assert from 'node:assert/strict';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { startModelStandIn, type ModelStandIn } from './lib/model-stand-in.js';
import { startSplitStack, type SplitStack } from './lib/split-stack.js';

const step = (message: string) => console.log(`\n▶ ${message}`);

interface Watched { page: Page; problems: string[] }

const EXPECTED = [/^401 GET \/api\/auth\/me$/];

async function watched(context: BrowserContext): Promise<Watched> {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const said = `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`;
    if (!EXPECTED.some((expected) => expected.test(said))) problems.push(said);
  });
  return { page, problems };
}

function nothingWentWrong(watching: Watched, during: string): void {
  assert.deepEqual(watching.problems, [], `the page reported problems during ${during}`);
}

async function signsIn(stack: SplitStack, watching: Watched): Promise<void> {
  step('the owner signs in on root\'s page with their password and lands on their instance, signed in');
  const { page } = watching;
  await page.goto(stack.rootUrl);
  await page.getByLabel('Email Address').fill(stack.owner.email);
  await page.getByLabel('Password').fill(stack.owner.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.origin === new URL(stack.instanceUrl).origin);
  await expect(page.getByRole('heading', { name: 'Give Koala a model to think with' })).toBeVisible();
  console.log(`  on ${new URL(page.url()).origin}, asked first for a model to think with`);
  nothingWentWrong(watching, 'signing in');
}

const ANSWER = 'The stand-in heard you and answers through the engine.';

async function chats(watching: Watched, model: ModelStandIn): Promise<void> {
  step('the owner gives Koala a model through Studio → Models, makes it the default, and Koala answers in a chat');
  const { page } = watching;
  await page.getByRole('link', { name: 'Or paste a key for any OpenAI-compatible provider' }).click();
  const custom = page.getByTestId('model-provider').filter({ hasText: 'Custom Endpoint' });
  await custom.getByRole('button', { name: 'Connect' }).click();
  await custom.getByLabel('Base URL').fill(model.baseUrl);
  await custom.getByLabel('Model Name').fill(model.model);
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/credentials/llm') && response.request().method() === 'POST');
  await custom.getByRole('button', { name: 'Connect and fetch models' }).click();
  const answer = await saved;
  console.log(`  saving the endpoint answered ${answer.status()}: ${(await answer.text()).slice(0, 300)}`);
  await page.getByLabel('Filter models').first().fill(model.model);
  await page.getByRole('button', { name: new RegExp(model.model) }).first().click();
  await expect(page.getByText(/^Currently:/)).toContainText(model.model);
  console.log(`  ${model.model} at ${model.baseUrl} is the default`);

  await page.goto(`${new URL(page.url()).origin}/#/chat`);
  await page.getByPlaceholder(/^Message/).fill('Are you there, Koala?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 60_000 });
  assert.ok(model.asked.some((text) => text.includes('Are you there, Koala?')), `the model was asked ${JSON.stringify(model.asked)}`);
  console.log('  the answer streamed back from the model through the engine');
  nothingWentWrong(watching, 'chatting');
}

async function seesInfrastructure(watching: Watched): Promise<void> {
  step('Infrastructure shows every section and what needs attention, asking nothing that fails');
  const { page } = watching;
  await page.getByRole('link', { name: 'Infrastructure' }).click();
  await expect(page.getByTestId('infrastructure-overview')).toBeVisible();
  await expect(page.getByText(/^checked /)).toBeVisible({ timeout: 60_000 });
  for (const title of ['Needs attention', 'Your own hardware', 'Model traffic', 'Alerts set', 'Alert history']) {
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  }
  console.log('  every section rendered');
  nothingWentWrong(watching, 'Infrastructure');
}

async function settingsThenSignsOut(stack: SplitStack, watching: Watched): Promise<void> {
  step('Settings shows the account and the instance\'s own settings, and logging out ends the session');
  const { page } = watching;
  const instance = new URL(stack.instanceUrl).origin;
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText(stack.owner.email).first()).toBeVisible();
  for (const section of ['Addresses', 'Updates', 'Notifications']) await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
  console.log('  the account, its addresses, updates and notifications');
  nothingWentWrong(watching, 'Settings');

  await page.getByRole('button', { name: 'Log Out' }).click();
  await page.waitForURL((url) => url.origin !== instance || url.hash.includes('signed-out'), { timeout: 30_000 }).catch(() => undefined);
  const me = await page.request.get(`${instance}/api/auth/me`);
  assert.equal(me.status(), 401, 'the instance still took the browser\'s session after logging out');
  console.log(`  signed out: the instance answers 401, the page is at ${page.url()}`);
}

async function main(): Promise<void> {
  step('a root, an instance with its engine worker and a hub start in containers from this commit\'s image');
  const stack = await startSplitStack({ engine: true });
  console.log(`  root ${stack.rootUrl}, instance ${stack.instanceUrl}`);
  const model = await startModelStandIn(ANSWER);
  const browser = await chromium.launch();
  let watching: Watched | undefined;
  try {
    const context = await browser.newContext();
    watching = await watched(context);
    await signsIn(stack, watching);
    await chats(watching, model);
    await seesInfrastructure(watching);
    await settingsThenSignsOut(stack, watching);
  } catch (err) {
    if (watching) {
      const shot = `${process.env.BROWSER_LIVE_SHOTS ?? '/tmp'}/browser-live-${Date.now()}.png`;
      await watching.page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      console.error(`\n── the page at ${watching.page.url()} (screenshot ${shot}) ──\n${(await watching.page.locator('body').innerText().catch(() => '')).slice(0, 2000)}`);
      console.error(`── what the page reported ──\n${watching.problems.join('\n')}`);
    }
    for (const side of ['root', 'instance'] as const) console.error(`\n── ${side}'s last lines ──\n${stack.logs(side, 40)}`);
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
