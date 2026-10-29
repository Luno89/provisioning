import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppImage } from './gate-runs.js';
import { roundsOf } from './gates.js';

export interface VmSuite {
  script: string;
  memoryMB: number;
}

export const VM_SUITES: readonly VmSuite[] = [
  { script: 'pool-live', memoryMB: 28672 },
  { script: 'restore-live', memoryMB: 24576 },
  { script: 'mesh-live', memoryMB: 15360 },
  { script: 'routing-live', memoryMB: 12288 },
  { script: 'byo-live', memoryMB: 12288 },
  { script: 'instance-live', memoryMB: 2048 },
];

export const roundsFor = (suites: readonly VmSuite[], availableMB: number): VmSuite[][] => roundsOf(suites, availableMB);

export function availableMemoryMB(meminfo = readFileSync('/proc/meminfo', 'utf8')): number {
  const kb = /MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1];
  if (!kb) throw new Error('/proc/meminfo has no MemAvailable');
  return Math.floor(Number(kb) / 1024);
}

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const LOGS = join(REPO, 'tests/.vm-logs');

const stamp = () => new Date().toISOString().slice(11, 19);

function runSuite(suite: VmSuite, logFile: string): Promise<{ suite: VmSuite; code: number; minutes: number }> {
  return new Promise((done) => {
    const started = Date.now();
    const log = createWriteStream(logFile);
    const child = spawn('npm', ['run', `test:${suite.script}`], { cwd: REPO, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const write = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line) log.write(`${stamp()} ${line}\n`);
    };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.on('close', (code) => {
      log.end();
      done({ suite, code: code ?? 1, minutes: Math.round((Date.now() - started) / 6000) / 10 });
    });
  });
}

async function main(): Promise<void> {
  const picked = process.argv.slice(2);
  const suites = picked.length ? VM_SUITES.filter((suite) => picked.includes(suite.script)) : VM_SUITES;
  const unknown = picked.filter((name) => !VM_SUITES.some((suite) => suite.script === name));
  if (unknown.length) throw new Error(`not VM suites: ${unknown.join(', ')} (known: ${VM_SUITES.map((suite) => suite.script).join(', ')})`);
  mkdirSync(LOGS, { recursive: true });

  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const image = buildAppImage(REPO, commit, (line) => console.log(`  ${line}`));
  execFileSync('docker', ['tag', image, 'nowrinkles/app:dev']);
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
