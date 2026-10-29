export interface InstanceRelease {
  imageTag: string;
  version: string;
  servedAt: string;
  notes?: string | undefined;
  hotfix?: boolean | undefined;
  digest?: string | undefined;
  chartSha256?: string | undefined;
  withdrawn?: Withdrawal | undefined;
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
  releases: ReleaseRow[];
}

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

export function choosable(releases: readonly InstanceRelease[], running: string | undefined, previous: string | undefined): string[] {
  const newer = newerThan(releases, running).filter((release) => !release.withdrawn).map((release) => release.imageTag);
  const back = previous && previous !== running && live(releases).some((release) => release.imageTag === previous) ? [previous] : [];
  return [...newer, ...back.filter((tag) => !newer.includes(tag))];
}

export function updateTarget(setting: UpdateSetting, running: string | undefined, current: string, releases: readonly InstanceRelease[]): string {
  if (!setting.auto) return setting.picked ?? running ?? current;
  if (!running || isWithdrawn(releases, running)) return current;
  return newerThan(releases, running).some((release) => release.imageTag === current) ? current : running;
}

export function findRelease(releases: readonly InstanceRelease[], name: string): InstanceRelease | undefined {
  return releases.find((release) => release.version === name) ?? releases.find((release) => release.imageTag === name);
}

export function pickProblem(releases: readonly InstanceRelease[], running: string | undefined, previous: string | undefined, name: string): string | undefined {
  const release = findRelease(releases, name);
  if (!release) return `there is no release ${name}`;
  if (release.withdrawn) return `${release.version} was withdrawn when ${release.withdrawn.by}; pick another release`;
  if (release.imageTag === running) return undefined;
  if (choosable(releases, running, previous).includes(release.imageTag)) return undefined;
  const back = previous ? findRelease(releases, previous)?.version ?? previous : undefined;
  return `${release.version} is older than what this instance runs; it can move to a newer release${back ? `, or back to ${back}, the one it ran before` : ''}`;
}

export function updatesView(setting: UpdateSetting, running: string | undefined, previous: string | undefined, current: string, releases: readonly InstanceRelease[]): UpdatesView {
  const open = choosable(releases, running, previous);
  return {
    auto: setting.auto,
    ...(setting.picked ? { picked: setting.picked } : {}),
    ...(running ? { running } : {}),
    ...(previous ? { previous } : {}),
    current,
    target: updateTarget(setting, running, current, releases),
    ...(running && isWithdrawn(releases, running) ? { runningWithdrawn: releases.find((release) => release.imageTag === running)!.withdrawn } : {}),
    releases: releaseOrder(releases).reverse().map((release) => ({
      ...release,
      running: release.imageTag === running,
      current: release.imageTag === current,
      choosable: open.includes(release.imageTag),
    })),
  };
}

export const pinned = (release: InstanceRelease | undefined): { imageDigest?: string; chartSha256?: string } => ({
  ...(release?.digest ? { imageDigest: release.digest } : {}),
  ...(release?.chartSha256 ? { chartSha256: release.chartSha256 } : {}),
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
