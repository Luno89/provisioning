import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Record = { passed?: string; failed?: string };
type Ledger = { [script: string]: Record };

const LEDGER = fileURLToPath(new URL('../last-passed.json', import.meta.url));
const TABLE = fileURLToPath(new URL('../LAST-PASSED.md', import.meta.url));

const readLedger = (): Ledger => {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger;
  } catch {
    return {};
  }
};

const day = (at: string | undefined): string => (at ? at.slice(0, 16).replace('T', ' ') : '—');

export function tableOf(ledger: Ledger): string {
  const rows = Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b));
  return [
    '# When each live and integration script last passed',
    '',
    'Written by `tests/lib/run-live.ts`, which every `npm run test:*-live` and `test:*-integration` script goes through. Times are UTC.',
    '',
    '| Script | Last passed | Last failed |',
    '|---|---|---|',
    ...rows.map(([script, record]) => `| \`${script}\` | ${day(record.passed)} | ${day(record.failed)} |`),
    '',
  ].join('\n');
}

export function recorded(ledger: Ledger, script: string, passed: boolean, at: string): Ledger {
  const current = ledger[script] ?? {};
  return { ...ledger, [script]: passed ? { ...current, passed: at } : { ...current, failed: at } };
}

function record(script: string, passed: boolean): void {
  const ledger = recorded(readLedger(), script, passed, new Date().toISOString());
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(TABLE, tableOf(ledger));
}

const script = process.argv[2];
const TSX = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
if (script && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL(`../${script}.ts`, import.meta.url));
  const child = spawn(process.execPath, [TSX, file, ...process.argv.slice(3)], { stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    record(script, code === 0);
    process.exit(code ?? (signal ? 1 : 0));
  });
}
