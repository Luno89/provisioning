import { succeeded } from '@koala/engine-core/processes';
import { hostContainers } from './dead-states.js';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppImage } from './gate-runs.js';
import { RELEASE_STEPS, roundsOf } from './gates.js';
import { here } from './processes.js';

export interface VmSuite {
  script: string;
  memoryMB: number;
}

const VM_SCRIPTS = ['restore-live', 'mesh-live', 'routing-live', 'instance-live'];

export const VM_SUITES: readonly VmSuite[] = VM_SCRIPTS.map((script) => {
  const step = RELEASE_STEPS.find((one) => one.script === `test:${script}`);
  if (step?.memoryMB === undefined) throw new Error(`${script} is not a release step with its memory`);
  return { script, memoryMB: step.memoryMB };
});

export const roundsFor = (suites: readonly VmSuite[], availableMB: number): VmSuite[][] => roundsOf(suites, availableMB);

export function availableMemoryMB(meminfo = readFileSync('/proc/meminfo', 'utf8')): number {
  const kb = /MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1];
  if (!kb) throw new Error('/proc/meminfo has no MemAvailable');
  return Math.floor(Number(kb) / 1024);
}

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const LOGS = join(REPO, 'tests/.vm-logs');

const stamp = () => new Date().toISOString().slice(11, 19);

async function runSuite(suite: VmSuite, logFile: string): Promise<{ suite: VmSuite; code: number; minutes: number }> {
  const started = Date.now();
  const log = createWriteStream(logFile);
  const write = (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) log.write(`${stamp()} ${line}\n`);
  };
  const ran = await here.run({ command: 'npm', args: ['run', `test:${suite.script}`], cwd: REPO }, { stdout: write, stderr: write }).finally(() => log.end());
  return { suite, code: ran.code, minutes: Math.round((Date.now() - started) / 6000) / 10 };
}

async function main(): Promise<void> {
  const picked = process.argv.slice(2);
  const suites = picked.length ? VM_SUITES.filter((suite) => picked.includes(suite.script)) : VM_SUITES;
  const unknown = picked.filter((name) => !VM_SUITES.some((suite) => suite.script === name));
  if (unknown.length) throw new Error(`not VM suites: ${unknown.join(', ')} (known: ${VM_SUITES.map((suite) => suite.script).join(', ')})`);
  mkdirSync(LOGS, { recursive: true });

  const commit = (await succeeded(here, { command: 'git', args: ['-C', REPO, 'rev-parse', 'HEAD'] })).trim();
  const image = await buildAppImage(REPO, commit, (line) => console.log(`  ${line}`));
  await hostContainers.tag(image, 'nowrinkles/app:dev');
  console.log(`  ${image} is nowrinkles/app:dev`);

  const available = availableMemoryMB();
  const rounds = roundsFor(suites, available);
  console.log(`${available} MB available: ${rounds.length} round${rounds.length === 1 ? '' : 's'}: ${rounds.map((round) => round.map((suite) => suite.script).join(' + ')).join(' → ')}`);

  const results: Array<{ suite: VmSuite; code: number; minutes: number; log: string }> = [];
  for (const [index, round] of rounds.entries()) {
    console.log(`\n${stamp()} round ${index + 1}: ${round.map((suite) => suite.script).join(', ')}`);
    const finished = await Promise.all(round.map((suite) => {
      const log = join(LOGS, `${suite.script}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      return runSuite(suite, log).then((result) => ({ ...result, log }));
    }));
    for (const result of finished) console.log(`${stamp()} ${result.code === 0 ? '✓' : '✗'} ${result.suite.script} in ${result.minutes} min (${result.log})`);
    results.push(...finished);
  }

  console.log('\n| Suite | Result | Minutes |\n|---|---|---|');
  for (const result of results) console.log(`| ${result.suite.script} | ${result.code === 0 ? 'passed' : `failed (${result.code})`} | ${result.minutes} |`);
  const failed = results.filter((result) => result.code !== 0);
  console.log(failed.length ? `\n${failed.length} of ${results.length} failed` : `\nall ${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
