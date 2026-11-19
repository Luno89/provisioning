import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshPlaces } from './fresh-places.js';
import { showGrowing } from './show-growing.js';
import { until, waiting } from './until.js';

const aPlace = freshPlaces('show-growing-');

function aLog(): string {
  const file = join(aPlace(), 'dev.log');
  writeFileSync(file, '');
  return file;
}

describe('a log shown in the terminal as it is written', () => {
  it('shows a question that waits on the same line for its answer', async () => {
    const file = aLog();
    let shown = '';
    const showing = showGrowing(file, (text) => { shown += text; });
    appendFileSync(file, 'This machine\'s own cluster\n');
    appendFileSync(file, '  Install k3s (asks for sudo once)? [y/N] ');
    await until('the question shown', async () => shown.endsWith('[y/N] ') ? true : waiting(`shown ends with ${JSON.stringify(shown.slice(-40))}`));
    showing.stop();
    expect(shown).toBe('This machine\'s own cluster\n  Install k3s (asks for sudo once)? [y/N] ');
  });

  it('shows what was written before it started, and nothing once stopped', async () => {
    const file = aLog();
    appendFileSync(file, 'already there\n');
    let shown = '';
    const showing = showGrowing(file, (text) => { shown += text; });
    appendFileSync(file, 'then this\n');
    showing.stop();
    appendFileSync(file, 'after ship is done\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toBe('already there\nthen this\n');
  });
});
