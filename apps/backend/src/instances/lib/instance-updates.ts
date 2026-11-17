import { parse } from 'yaml';
export interface InstanceRelease {
  imageTag: string;
  version: string;
  servedAt: string;
  notes?: string | undefined;
  hotfix?: boolean | undefined;
  digest?: string | undefined;
  chartSha256?: string | undefined;
  withdrawn?: Withdrawal | undefined;
  dataVersion?: number | undefined;
}

export interface Withdrawal {
  at: string;
  by: string;
}

export interface UpdateSetting {
  auto: boolean;
  picked?: string | undefined;
}

export const DEFAULT_UPDATES: UpdateSetting = { auto: true };

export interface ReleaseRow extends InstanceRelease {
  running: boolean;
  current: boolean;
  choosable: boolean;
}

export interface UpdatesView {
  auto: boolean;
  picked?: string | undefined;
  running?: string | undefined;
  previous?: string | undefined;
  current: string;
  target: string;
  runningWithdrawn?: Withdrawal | undefined;
  heldByData?: { version: string; needs: number } | undefined;
  releases: ReleaseRow[];
}

export const dataOf = (release: InstanceRelease | undefined): number => release?.dataVersion ?? 0;

export function dataVersionOf(valuesYaml: string): number {
  const values: unknown = parse(valuesYaml);
  const declared = values && typeof values === 'object' ? (values as { dataVersion?: unknown }).dataVersion : undefined;
  if (declared === undefined) return 0;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) throw new Error(`the instance chart's dataVersion is ${String(declared)}, not a whole number`);
  return declared;
}

const canRun = (releases: readonly InstanceRelease[], imageTag: string, needs: number): boolean => {
  const release = releases.find((one) => one.imageTag === imageTag);
  return !release || dataOf(release) >= needs;
};

const HOTFIX_LINE = /^Hotfix released from /m;

export function releaseFromTag(imageTag: string, tag: string | undefined, message: string | undefined, servedAt: string): InstanceRelease {
  if (!tag) return { imageTag, version: imageTag, servedAt };
  const notes = (message ?? '').split('\n').slice(1).join('\n').trim();
  return { imageTag, version: tag, servedAt, ...(notes ? { notes } : {}), ...(HOTFIX_LINE.test(notes) ? { hotfix: true } : {}) };
}

export const releaseOrder = (releases: readonly InstanceRelease[]): InstanceRelease[] =>
  [...releases].sort((a, b) => a.servedAt.localeCompare(b.servedAt) || a.imageTag.localeCompare(b.imageTag));

export const isWithdrawn = (releases: readonly InstanceRelease[], imageTag: string | undefined): boolean =>
  imageTag !== undefined && releases.some((release) => release.imageTag === imageTag && release.withdrawn !== undefined);

const live = (releases: readonly InstanceRelease[]): InstanceRelease[] => releases.filter((release) => !release.withdrawn);

export function withdrawnBy(releases: readonly InstanceRelease[], current: string): { clear: boolean; withdraw: string[] } {
  const own = releases.find((release) => release.imageTag === current);
  if (!own) return { clear: false, withdraw: [] };
  const ordered = releaseOrder(releases);
  const at = ordered.findIndex((release) => release.imageTag === current);
  return {
    clear: own.withdrawn !== undefined,
    withdraw: ordered.slice(at + 1).filter((release) => !release.withdrawn).map((release) => release.imageTag),
  };
}

export const rolledBackTo = (version: string): string => `root rolled back to ${version}`;

export function newerThan(releases: readonly InstanceRelease[], running: string | undefined): InstanceRelease[] {
  const ordered = releaseOrder(releases);
  const at = running ? ordered.findIndex((release) => release.imageTag === running) : -1;
  return at < 0 ? ordered.filter((release) => release.imageTag !== running) : ordered.slice(at + 1);
}

export function choosable(releases: readonly InstanceRelease[], running: string | undefined, previous: string | undefined, needs = 0): string[] {
  const newer = newerThan(releases, running).filter((release) => !release.withdrawn).map((release) => release.imageTag);
  const back = previous && previous !== running && live(releases).some((release) => release.imageTag === previous) ? [previous] : [];
  return [...newer, ...back.filter((tag) => !newer.includes(tag))].filter((tag) => canRun(releases, tag, needs));
}

function wantedTarget(setting: UpdateSetting, running: string | undefined, current: string, releases: readonly InstanceRelease[]): string {
  if (!setting.auto) return setting.picked ?? running ?? current;
  if (!running || isWithdrawn(releases, running)) return current;
  return newerThan(releases, running).some((release) => release.imageTag === current) ? current : running;
}

export function updateTarget(setting: UpdateSetting, running: string | undefined, current: string, releases: readonly InstanceRelease[], needs = 0): string {
  const wanted = wantedTarget(setting, running, current, releases);
  return running && !canRun(releases, wanted, needs) ? running : wanted;
}

export function findRelease(releases: readonly InstanceRelease[], name: string): InstanceRelease | undefined {
  return releases.find((release) => release.version === name) ?? releases.find((release) => release.imageTag === name);
}

export function pickProblem(releases: readonly InstanceRelease[], running: string | undefined, previous: string | undefined, name: string, needs = 0): string | undefined {
  const release = findRelease(releases, name);
  if (!release) return `there is no release ${name}`;
  if (release.withdrawn) return `${release.version} was withdrawn when ${release.withdrawn.by}; pick another release`;
  if (release.imageTag === running) return undefined;
  if (dataOf(release) < needs) return `${release.version} cannot run this instance's data: a later release moved it forward for good (data version ${needs}), and ${release.version} knows only data version ${dataOf(release)}`;
  if (choosable(releases, running, previous, needs).includes(release.imageTag)) return undefined;
  const back = previous ? findRelease(releases, previous)?.version ?? previous : undefined;
  return `${release.version} is older than what this instance runs; it can move to a newer release${back ? `, or back to ${back}, the one it ran before` : ''}`;
}

export function updatesView(setting: UpdateSetting, running: string | undefined, previous: string | undefined, current: string, releases: readonly InstanceRelease[], needs = 0): UpdatesView {
  const open = choosable(releases, running, previous, needs);
  const wanted = wantedTarget(setting, running, current, releases);
  const held = running && !canRun(releases, wanted, needs) ? releases.find((release) => release.imageTag === wanted) : undefined;
  return {
    auto: setting.auto,
    ...(setting.picked ? { picked: setting.picked } : {}),
    ...(running ? { running } : {}),
    ...(previous ? { previous } : {}),
    current,
    target: updateTarget(setting, running, current, releases, needs),
    ...(held ? { heldByData: { version: held.version, needs } } : {}),
    ...(running && isWithdrawn(releases, running) ? { runningWithdrawn: releases.find((release) => release.imageTag === running)!.withdrawn } : {}),
    releases: releaseOrder(releases).reverse().map((release) => ({
      ...release,
      running: release.imageTag === running,
      current: release.imageTag === current,
      choosable: open.includes(release.imageTag),
    })),
  };
}

export const pinned = (release: InstanceRelease | undefined): { imageDigest?: string; chartSha256?: string; dataVersion?: number } => ({
  ...(release?.digest ? { imageDigest: release.digest } : {}),
  ...(release?.chartSha256 ? { chartSha256: release.chartSha256 } : {}),
  ...(release?.dataVersion ? { dataVersion: release.dataVersion } : {}),
});

export interface WithdrawalHeld { instanceId: string; ownerId: string; name?: string | undefined; release: InstanceRelease; key: string }

export function withdrawalsHeld(
  instances: readonly { id: string; ownerId: string; name?: string | undefined; updates?: UpdateSetting | undefined; running?: string | undefined }[],
  releases: readonly InstanceRelease[],
): WithdrawalHeld[] {
  return instances.flatMap((instance) => {
    if (instance.updates?.auto !== false) return [];
    const held = instance.updates.picked ?? instance.running;
    const release = releases.find((one) => one.imageTag === held && one.withdrawn);
    if (!release) return [];
    return [{ instanceId: instance.id, ownerId: instance.ownerId, name: instance.name, release, key: `${instance.id}|${release.imageTag}|${release.withdrawn!.at}` }];
  });
}

export function withdrawalMail(held: WithdrawalHeld, rootRelease: InstanceRelease | undefined): { subject: string; text: string } {
  const where = held.name ? `Your instance ${held.name}` : 'Your instance';
  const offer = rootRelease ? ` Root runs ${rootRelease.version}; you can move to it in your instance's Settings → Updates, or switch automatic updates back on.` : ' You can pick another release in your instance\'s Settings → Updates.';
  return {
    subject: `${held.release.version} was withdrawn`,
    text: `${where} is set to run ${held.release.version}, which was withdrawn when ${held.release.withdrawn!.by}. It stays on it until you choose otherwise.${offer}`,
  };
}

export interface DataHeld { instanceId: string; ownerId: string; name?: string | undefined; release: InstanceRelease; needs: number; key: string }

export function dataHolds(
  instances: readonly { id: string; ownerId: string; name?: string | undefined; updates?: UpdateSetting | undefined; running?: string | undefined; dataVersion?: number | undefined }[],
  releases: readonly InstanceRelease[],
  current: string,
): DataHeld[] {
  return instances.flatMap((instance) => {
    const needs = instance.dataVersion ?? 0;
    const wanted = wantedTarget(instance.updates ?? DEFAULT_UPDATES, instance.running, current, releases);
    if (!instance.running || canRun(releases, wanted, needs)) return [];
    const release = releases.find((one) => one.imageTag === wanted)!;
    return [{ instanceId: instance.id, ownerId: instance.ownerId, name: instance.name, release, needs, key: `${instance.id}|${release.imageTag}|${needs}` }];
  });
}

export function dataHeldMail(held: DataHeld): { subject: string; text: string } {
  const who = held.name ? `Your instance ${held.name}` : 'Your instance';
  return {
    subject: `${held.name ?? 'Your instance'} stays on its release`,
    text: `${who} stays on the release it runs: root now offers ${held.release.version}, which cannot run its data, since a later release moved it forward for good (data version ${held.needs}). It moves again once root offers a release that can.`,
  };
}
