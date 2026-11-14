import assert from 'node:assert/strict';
import type { BrowserContext, Page } from '@playwright/test';

export interface Watched { page: Page; problems: string[] }

const EXPECTED = [/^401 GET \/api\/auth\/me$/];

export async function watched(context: BrowserContext): Promise<Watched> {
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

export function nothingWentWrong(watching: Watched, during: string): void {
  assert.deepEqual(watching.problems, [], `the page reported problems during ${during}`);
}
