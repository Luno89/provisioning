export const LEDGER_FILES = ['tests/last-passed.json', 'tests/LAST-PASSED.md'];

export interface GateStep { name: string; script: string }

export const SHIP_STEPS: GateStep[] = [
  { name: 'typecheck and the unit suites', script: 'test:unit' },
  { name: 'lint', script: 'lint' },
  { name: 'every router answers', script: 'test:routes-live' },
  { name: 'an account removes itself', script: 'test:account-removal-live' },
  { name: 'the hub\'s people and roles', script: 'test:hub-live' },
  { name: 'sharing a project and taking it back', script: 'test:project-sharing-live' },
  { name: 'one trace end to end', script: 'test:telemetry-live' },
  { name: 'two owners\' apps of one name', script: 'test:app-names-live' },
  { name: 'files on MinIO, share links, an attachment', script: 'test:files-live' },
  { name: 'an Odoo release cut over and rolled back', script: 'test:odoo-release-live' },
  { name: 'the mechanics checks', script: 'test:checks-live' },
];

export const RELEASE_STEPS: GateStep[] = [
  { name: 'the mail server signs and refuses to relay', script: 'test:mail-live' },
  { name: 'a cluster provisioned, verified and destroyed', script: 'test:infra:integration' },
  { name: 'an instance on k3d signs in through root', script: 'test:instance-live' },
  { name: 'a machine joins and its agents are found', script: 'test:machine-live' },
  { name: 'install.sh on a VM, sign-in and a self-upgrade', script: 'test:byo-live' },
  { name: 'a VM provisioned as a remote cluster', script: 'test:remote-integration' },
  { name: 'the mesh keeps people apart', script: 'test:mesh-live' },
  { name: 'addresses through root\'s Caddy', script: 'test:routing-live' },
  { name: 'a pool trial and its move', script: 'test:pool-live' },
  { name: 'the release rehearsal', script: 'test:release-live' },
];

export const HOTFIX_STEPS: GateStep[] = [
  { name: 'typecheck', script: 'typecheck' },
];

export const HOTFIX = '--hotfix';

export interface StepPassed { name: string; script: string; minutes: number }

export interface Passed { at: string; steps: StepPassed[]; hotfix?: true | undefined }

export interface GateRecord {
  commit: string;
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

export const TAG_SIGNATURE = /^(Shipped and released|Hotfix released) from /m;

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

export const onlyLedger = (changed: readonly string[]): boolean => changed.length > 0 && changed.every((path) => LEDGER_FILES.includes(path));
