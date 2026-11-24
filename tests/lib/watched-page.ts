import assert from 'node:assert/strict';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { until, waiting } from './until.js';

export interface Watched { page: Page; problems: string[]; navigations?: number }

const EXPECTED = [/^401 GET \/api\/auth\/me$/];

export async function watched(context: BrowserContext): Promise<Watched> {
  context.setDefaultTimeout(0);
  context.setDefaultNavigationTimeout(0);
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
  const watching: Watched = { page, problems, navigations: 0 };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) watching.navigations = (watching.navigations ?? 0) + 1; });
  return watching;
}

export function nothingWentWrong(watching: Watched, during: string): void {
  assert.deepEqual(watching.problems, [], `the page reported problems during ${during}`);
}

export type Ended = () => Promise<string | undefined>;

const endedFor = (watching: Watched, ended?: Ended) => async (): Promise<string | undefined> => {
  if (watching.page.isClosed()) return 'the page closed';
  if (watching.problems.length > 0) return `the page reported ${watching.problems.join('; ')}`;
  return ended?.();
};

export const seen = (watching: Watched, what: string, target: Locator, ended?: Ended): Promise<Locator> =>
  until(what, async () => (await target.first().isVisible() ? target.first() : waiting(`not shown; the page is at ${watching.page.url()}`)), endedFor(watching, ended));

export const reached = (watching: Watched, what: string, at: (url: URL) => boolean, ended?: Ended): Promise<URL> =>
  until(what, async () => { const now = new URL(watching.page.url()); return at(now) ? now : waiting(`the page is at ${now.href}`); }, endedFor(watching, ended));
