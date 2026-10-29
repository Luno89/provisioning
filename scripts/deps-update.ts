import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COOLING_OFF_DAYS, compareVersions } from '../tests/lib/gates.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const cutoff = new Date(Date.now() - COOLING_OFF_DAYS * 24 * 60 * 60 * 1000);

interface Manifest { name?: string; overrides?: Record<string, string>; [field: string]: unknown }

const npm = (args: string[]): string => {
  const ran = spawnSync('npm', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
  if (ran.status !== 0) throw new Error(`npm ${args.join(' ')} ended with ${ran.status}`);
  return ran.stdout;
};

const asWritten = (manifest: Manifest): string =>
  `${JSON.stringify(manifest, null, 2).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;

const manifestAt = (folder: string): Manifest => JSON.parse(readFileSync(join(REPO, folder, 'package.json'), 'utf8')) as Manifest;

const WORKSPACES = ['.', ...((manifestAt('.').workspaces as string[] | undefined) ?? []).flatMap((pattern) => {
  const parent = pattern.replace(/\/\*$/, '');
  return readdirSync(join(REPO, parent)).map((child) => `${parent}/${child}`).filter((folder) => existsSync(join(REPO, folder, 'package.json')));
})];

const majorOf = (version: string): string => version.split('.')[0] ?? '';

function installedMajors(name: string): Set<string> {
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string }> };
  return new Set(Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path.endsWith(`node_modules/${name}`) && entry.version)
    .map(([, entry]) => majorOf(entry.version!)));
}

function newestOldEnough(name: string): { version: string; publishedAt: string } | undefined {
  const times = JSON.parse(npm(['view', name, 'time', '--json'])) as Record<string, string>;
  const majors = installedMajors(name);
  return Object.entries(times)
    .filter(([version, at]) => /^\d+\.\d+\.\d+$/.test(version) && Date.parse(at) <= cutoff.getTime() && (majors.size === 0 || majors.has(majorOf(version))))
    .sort(([a], [b]) => compareVersions(b, a))
    .map(([version, publishedAt]) => ({ version, publishedAt }))[0];
}

function take(name: string): void {
  const newest = newestOldEnough(name);
  if (!newest) throw new Error(`${name} has no version in the major it is on that was published at least ${COOLING_OFF_DAYS} days ago`);
  const declaring = WORKSPACES.filter((folder) => DEPENDENCY_FIELDS.some((field) => (manifestAt(folder)[field] as Record<string, string> | undefined)?.[name]));
  if (declaring.length > 0) {
    for (const folder of declaring) {
      const manifest = manifestAt(folder);
      const field = DEPENDENCY_FIELDS.find((one) => (manifest[one] as Record<string, string> | undefined)?.[name])!;
      const range = (manifest[field] as Record<string, string>)[name]!;
      const prefix = /^[\^~]/.test(range) ? range[0] : '';
      (manifest[field] as Record<string, string>)[name] = `${prefix}${newest.version}`;
      writeFileSync(join(REPO, folder, 'package.json'), asWritten(manifest));
      console.log(`${folder === '.' ? 'the root' : folder}: ${name} ${range} → ${prefix}${newest.version} (published ${newest.publishedAt.slice(0, 10)})`);
    }
  } else {
    const root = manifestAt('.');
    root.overrides = { ...(root.overrides ?? {}), [name]: newest.version };
    writeFileSync(join(REPO, 'package.json'), asWritten(root));
    console.log(`the root's overrides: ${name} → ${newest.version} (published ${newest.publishedAt.slice(0, 10)}), since no workspace names it`);
  }
}

const named = process.argv.slice(2);
const before = cutoff.toISOString();
if (named.length === 0) {
  console.log(`updating every package within its range to versions published before ${before.slice(0, 10)}`);
  npm(['update', `--before=${before}`]);
} else {
  for (const name of named) take(name);
  npm(['update', ...named]);
}
npm(['run', 'postinstall', '--if-present']);
console.log('done: review `git diff package.json package-lock.json`, then run the unit suites');
