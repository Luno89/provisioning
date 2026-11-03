import assert from 'node:assert/strict';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
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

async function main(): Promise<void> {
  step('a root, an instance with its engine worker and a hub start in containers from this commit\'s image');
  const stack = await startSplitStack({ engine: true });
  console.log(`  root ${stack.rootUrl}, instance ${stack.instanceUrl}`);
  const browser = await chromium.launch();
  let watching: Watched | undefined;
  try {
    const context = await browser.newContext();
    watching = await watched(context);
    await signsIn(stack, watching);
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
    await stack.stop();
  }
  console.log('\nbrowser live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
