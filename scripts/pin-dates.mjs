import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const PINS = fileURLToPath(new URL('../dependencies.pins.json', import.meta.url));

export const datedPin = (component) => Boolean(component.github) || component.kind === 'chart';

export const missingDates = (pins) => pins.components.filter((component) => datedPin(component) && !component.released);

const SHA = /^[0-9a-f]{40}$/;

export function tagCandidates(component) {
  const bare = component.version.replace(/^v/, '');
  const short = component.name.split('/').pop();
  const named = component.source?.match(/\/releases\/download\/([^/]+)\//)?.[1];
  return [...new Set([
    ...(named ? [decodeURIComponent(named)] : []), component.version, `v${bare}`, bare, `v${bare.replace(/-\d+$/, '')}`, `v${bare.replace(/-k3s/, '+k3s')}`,
    `${short}-${bare}`, `${short}-v${bare}`, `helm-${short}-${bare}`, `release-${bare}`, `docker-v${bare}`,
  ])];
}

export const utc = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
}).trim();

const tagsOf = new Map();
function tags(repo) {
  if (!tagsOf.has(repo)) {
    const listed = git(tmpdir(), ['ls-remote', '--tags', `https://github.com/${repo}.git`]);
    tagsOf.set(repo, new Set(listed.split('\n').filter(Boolean).map((line) => line.split('\t')[1].replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''))));
  }
  return tagsOf.get(repo);
}

function gitDate(repo, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'pin-date-'));
  try {
    git(dir, ['init', '--bare', '-q']);
    if (SHA.test(ref)) {
      git(dir, ['fetch', '-q', '--depth=1', `https://github.com/${repo}.git`, ref]);
      return utc(git(dir, ['log', '-1', '--format=%cI', ref]));
    }
    git(dir, ['fetch', '-q', '--depth=1', '--no-tags', `https://github.com/${repo}.git`, `refs/tags/${ref}:refs/tags/${ref}`]);
    const [tagged, committed] = git(dir, ['for-each-ref', '--format=%(taggerdate:iso-strict)|%(committerdate:iso-strict)', `refs/tags/${ref}`]).split('|');
    return utc(tagged || committed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const indexes = new Map();
async function chartDate(component) {
  const url = `${component.source.replace(/\/$/, '')}/index.yaml`;
  if (!indexes.has(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    indexes.set(url, parse(await response.text()));
  }
  const entry = indexes.get(url).entries?.[component.name]?.find((chart) => chart.version.replace(/^v/, '') === component.version.replace(/^v/, ''));
  if (!entry?.created) throw new Error(`${url} lists no ${component.name} ${component.version}`);
  return utc(entry.created);
}

export async function releasedOf(component) {
  if (component.kind === 'chart') return chartDate(component);
  const ref = component.commit ?? (SHA.test(component.version) ? component.version : tagCandidates(component).find((tag) => tags(component.github).has(tag)));
  if (!ref) throw new Error(`no tag in ${component.github} matches ${component.version} (tried ${tagCandidates(component).join(', ')})`);
  return gitDate(component.github, ref);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pins = JSON.parse(readFileSync(PINS, 'utf8'));
  const missing = missingDates(pins);
  if (process.argv[2] === '--check') {
    for (const component of missing) console.error(`${component.name}@${component.version} has no released date`);
    process.exit(missing.length === 0 ? 0 : 1);
  }
  const failed = [];
  for (const component of missing) {
    try {
      component.released = await releasedOf(component);
      console.log(`${component.name}@${component.version}: ${component.released}`);
    } catch (err) {
      failed.push(`${component.name}@${component.version}: ${err.message}`);
    }
  }
  writeFileSync(PINS, `${JSON.stringify(pins, null, 2)}\n`);
  for (const line of failed) console.error(line);
  process.exit(failed.length === 0 ? 0 : 1);
}
