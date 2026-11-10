import { COOLING_OFF_DAYS, devOnly, type JudgedVulnerability, type Vulnerability } from '../../apps/backend/src/platform/lib/dependency-rule.js';

export { COOLING_OFF_DAYS, compareVersions, devOnly, fixOf, judgeVulnerabilities, type JudgedVulnerability, type Vulnerability } from '../../apps/backend/src/platform/lib/dependency-rule.js';

export const LEDGER_FILES = ['tests/last-passed.json', 'tests/LAST-PASSED.md', 'tests/coupling/baseline.json', 'tests/test-failures.json'];

export interface GateStep { name: string; script: string; memoryMB?: number; alone?: true }

export const UNIT_STEPS: GateStep[] = [
  { name: 'typecheck and the unit tier', script: 'test:unit' },
  { name: 'lint', script: 'lint' },
];

export const INTEGRATION_STEPS: GateStep[] = [
  { name: 'the integration tier, both tiers gathering what they run', script: 'test:integration:coupled' },
];

export const E2E_STEPS: GateStep[] = [
  { name: 'a person in a browser: sign-in, a first model and a chat, Infrastructure, Settings, sign-out', script: 'test:browser-live' },
  { name: 'an Odoo release cut over and rolled back', script: 'test:odoo-release-live' },
  { name: 'an app deploys on the machine Koala runs on, its sign-in shown only on asking, and is destroyed', script: 'test:app-sign-in-live' },
  { name: 'the mechanics checks', script: 'test:checks-live' },
];

export const LAYER_STEPS: GateStep[] = [
  { name: 'the coupling rules, over both tiers and the live suites', script: 'test:coupling:live' },
];

export const SHIP_STEPS: GateStep[] = [...UNIT_STEPS, ...INTEGRATION_STEPS, ...E2E_STEPS, ...LAYER_STEPS];

export const RELEASE_STEPS: GateStep[] = [
  { name: 'the mail server signs and refuses to relay', script: 'test:mail-live', memoryMB: 512 },
  { name: 'every service on root measured on loopback and relayed with its service name', script: 'test:root-metrics-live', memoryMB: 1536 },
  { name: 'production refuses what only a dev box allows, and sees each visitor', script: 'test:hardening-live', memoryMB: 2048 },
  { name: 'files on MinIO, share links, an attachment', script: 'test:files-live', memoryMB: 1024 },
  { name: 'an instance on k3d signs in through root', script: 'test:instance-live', memoryMB: 2048 },
  { name: 'a machine joins and its agents are found', script: 'test:machine-live', memoryMB: 4096 },
  { name: 'install.sh on a VM, sign-in and a self-upgrade', script: 'test:byo-live', memoryMB: 12288 },
  { name: 'the mesh keeps people apart, and a machine\'s own cluster starts and stops with its apps', script: 'test:mesh-live', memoryMB: 19456 },
  { name: 'addresses through root\'s Caddy', script: 'test:routing-live', memoryMB: 12288 },
  { name: 'a pool trial and its move', script: 'test:pool-live', memoryMB: 28672 },
  { name: 'what was made in a live Odoo brought into git', script: 'test:odoo-customizations-live', memoryMB: 2048 },
  { name: 'a root restored from its backup on a fresh host', script: 'test:restore-live', memoryMB: 24576 },
  { name: 'the release rehearsal', script: 'test:release-live', memoryMB: 24576 },
];

export const HOTFIX_STEPS: GateStep[] = [
  { name: 'typecheck', script: 'typecheck' },
];

export const HOTFIX = '--hotfix';

export interface StepPassed { name: string; script: string; minutes: number }

export interface Passed { at: string; steps: StepPassed[]; hotfix?: true | undefined }

export interface GateRecord {
  commit: string;
  checked?: StepPassed[] | undefined;
  shipped?: Passed | undefined;
  released?: (Passed & { version: string; previous: string }) | undefined;
}

export interface PushedGates {
  record?: GateRecord | undefined;
  parent?: GateRecord | undefined;
  onlyLedgerSinceParent: boolean;
}

export const shippedThrough = (gates: PushedGates): Passed | undefined =>
  gates.record?.shipped ?? (gates.onlyLedgerSinceParent ? gates.parent?.shipped : undefined);

export function pushRefusal(ref: string, gates: PushedGates): string | undefined {
  if (ref === 'refs/heads/main') {
    if (shippedThrough(gates)) return undefined;
    return 'main takes only a commit that passed `npm run ship`, which runs the first two gates and pushes it for you. Use `git push --no-verify` only if you mean to push it untested.';
  }
  const tag = /^refs\/tags\/(v.+)$/.exec(ref)?.[1];
  if (tag) {
    if (gates.record?.released?.version === tag) return undefined;
    return `the tag ${tag} names a commit that never passed \`npm run release\`, which runs the VM suites and the release rehearsal and makes the tag itself.`;
  }
  return undefined;
}

export function ignoredRefusal(ignored: readonly string[]): string | undefined {
  if (ignored.length === 0) return undefined;
  const shown = ignored.slice(0, 10).join(', ');
  const more = ignored.length > 10 ? ` and ${ignored.length - 10} more` : '';
  const what = ignored.length === 1 ? 'a file .gitignore lists' : `${ignored.length} files .gitignore lists`;
  return `it carries ${what}, the way the dev box's Infisical keys were once published: ${shown}${more}. Untrack them with \`git rm --cached\`, or give one that belongs in git an exception in .gitignore.`;
}

export const NO_COMMIT = '0000000000000000000000000000000000000000';

export const pushedRange = (remoteSha: string | undefined, localSha: string): string =>
  remoteSha && remoteSha !== NO_COMMIT ? `${remoteSha}..${localSha}` : `${localSha} --not --remotes=origin`;

export const leaksRefusal = (findings: string | undefined): string | undefined =>
  findings ? `Gitleaks finds what looks like a secret in the commits it carries (values redacted):\n${findings}\nTake it out of those commits, or, when it is a test's made-up value, add the finding's fingerprint to .gitleaksignore.` : undefined;

interface OsvFinding { package: { name: string; version: string }; dependency_groups?: string[]; vulnerabilities?: OsvVulnerability[] }
interface OsvVulnerability { id: string; affected?: { package?: { name?: string }; ranges?: { events?: { fixed?: string }[] }[] }[] }

const fixedVersionsOf = (vulnerability: OsvVulnerability, name: string): string[] =>
  (vulnerability.affected ?? [])
    .filter((affected) => affected.package?.name === name)
    .flatMap((affected) => affected.ranges ?? [])
    .flatMap((range) => range.events ?? [])
    .flatMap((event) => (event.fixed ? [event.fixed] : []));

export const productionVulnerabilities = (report: unknown): Vulnerability[] =>
  ((report as { results?: { packages?: OsvFinding[] }[] } | undefined)?.results ?? [])
    .flatMap((result) => result.packages ?? [])
    .filter((found) => !devOnly({ dependencyGroups: found.dependency_groups }))
    .flatMap((found) => (found.vulnerabilities ?? []).map((vulnerability) => ({
      id: vulnerability.id,
      name: found.package.name,
      version: found.package.version,
      fixed: fixedVersionsOf(vulnerability, found.package.name),
    })));

export const takeNowLines = (due: readonly JudgedVulnerability[]): string[] =>
  due.map(({ vulnerability, fix, publishedAt }) => {
    const where = `${vulnerability.name}@${vulnerability.version}: https://osv.dev/${vulnerability.id}`;
    if (!fix) return `${where} (no fixed version yet): add its id to osv-scanner.toml with why it stays`;
    if (!publishedAt) return `${where} (fixed in ${fix}; its publish date could not be read): npm run deps:update -- ${vulnerability.name}`;
    return `${where} (fixed in ${fix}, published ${publishedAt.slice(0, 10)}): npm run deps:update -- ${vulnerability.name}`;
  });

export const waitingLines = (waiting: readonly JudgedVulnerability[]): string[] =>
  waiting.map(({ vulnerability, fix, takeOn }) => `${vulnerability.name}@${vulnerability.version}: https://osv.dev/${vulnerability.id}, fixed in ${fix}, which can be taken on ${takeOn}`);

export const TAG_SIGNATURE = /^(Shipped and released|Hotfix released) from /m;

export const RELEASE_SIGNERS = 'scripts/root-node/release-signers';

export const unsignedTagRefusal = (tag: string, problem: string | undefined): string | undefined =>
  problem ? `root would refuse ${tag}: ${problem}. \`npm run release\` signs the tag with your release key.` : undefined;

export function signingKeyProblem(keyPath: string, publicKey: string | undefined, signers: string | undefined): string | undefined {
  if (!publicKey) return `there is no release key at ${keyPath} (no ${keyPath}.pub). Make one with \`ssh-keygen -t ed25519 -f ${keyPath}\`, or point KOALA_RELEASE_KEY at yours`;
  const material = publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
  const trusted = (signers ?? '').split('\n').some((line) => !line.trimStart().startsWith('#') && line.includes(material));
  return trusted ? undefined : `${keyPath} is not in ${RELEASE_SIGNERS}, so the Release workflow and root would refuse what it signs. Add its public half there and ship that first`;
}

export function tagMessage(version: string, commit: string, previous: string, steps: readonly StepPassed[], hotfix: boolean): string {
  const ran = steps.map((step) => step.script.replace(/^test:/, '')).join(', ');
  return hotfix
    ? `${version}\n\nHotfix released from ${commit.slice(0, 12)} after ${previous} without the gates: ${ran} and the image build.`
    : `${version}\n\nShipped and released from ${commit.slice(0, 12)} after ${previous}: ${ran}.`;
}

export function nextVersion(today: string, tags: readonly string[]): string {
  const base = `v${today.slice(0, 10).replaceAll('-', '.')}`;
  if (!tags.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!tags.includes(`${base}-${n}`)) return `${base}-${n}`;
}

export function changedBesidesLedger(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const path = line.slice(3);
      const renamed = path.indexOf(' -> ');
      return renamed >= 0 ? path.slice(renamed + 4) : path;
    })
    .filter((path) => !LEDGER_FILES.includes(path));
}

export const checkedThrough = (gates: PushedGates): StepPassed[] =>
  [...(gates.record?.checked ?? []), ...(gates.onlyLedgerSinceParent ? gates.parent?.checked ?? [] : [])];

export const shortName = (script: string): string => script.replace(/^test:/, '');

export const shipRun = (steps: readonly GateStep[], checked: readonly StepPassed[], only: string | undefined): { steps: GateStep[] } | { refused: string } => {
  if (only === undefined) return { steps: stillToRun(steps, checked) };
  const at = steps.findIndex((step) => step.script === only || shortName(step.script) === only);
  if (at < 0) return { refused: `ship has no step ${only}; its steps are ${steps.map((step) => shortName(step.script)).join(', ')}` };
  const step = steps[at]!;
  if (LAYER_STEPS.some((layer) => layer.script === step.script)) {
    const missing = stillToRun(steps.slice(0, at), checked);
    if (missing.length > 0) return { refused: `the coupling rules judge what every step before them gathered on this commit, and ${missing.map((left) => shortName(left.script)).join(', ')} ${missing.length === 1 ? 'has' : 'have'} not passed on it yet` };
  }
  return { steps: [step] };
};

export const stillToRun = (steps: readonly GateStep[], checked: readonly StepPassed[]): GateStep[] =>
  steps.filter((step) => !checked.some((passed) => passed.script === step.script));

export function roundsOf<T extends { memoryMB?: number | undefined; alone?: true | undefined }>(items: readonly T[], availableMB: number): T[][] {
  const rounds: T[][] = items.filter((item) => item.alone).map((item) => [item]);
  const waiting = items.filter((item) => !item.alone).sort((a, b) => (b.memoryMB ?? 0) - (a.memoryMB ?? 0));
  while (waiting.length) {
    const round: T[] = [];
    let left = availableMB;
    for (let i = 0; i < waiting.length;) {
      const item = waiting[i]!;
      const needs = item.memoryMB ?? 0;
      if (needs <= left || round.length === 0) {
        round.push(item);
        left -= needs;
        waiting.splice(i, 1);
      } else {
        i += 1;
      }
    }
    rounds.push(round);
  }
  return rounds;
}

export const onlyLedger = (changed: readonly string[]): boolean => changed.length > 0 && changed.every((path) => LEDGER_FILES.includes(path));
