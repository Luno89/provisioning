export interface InstanceRelease {
  imageTag: string;
  version: string;
  servedAt: string;
  notes?: string | undefined;
  hotfix?: boolean | undefined;
  digest?: string | undefined;
  chartSha256?: string | undefined;
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

export function newerThan(releases: readonly InstanceRelease[], running: string | undefined): InstanceRelease[] {
  const ordered = releaseOrder(releases);
  const at = running ? ordered.findIndex((release) => release.imageTag === running) : -1;
  return at < 0 ? ordered.filter((release) => release.imageTag !== running) : ordered.slice(at + 1);
}

export function choosable(releases: readonly InstanceRelease[], running: string | undefined, previous: string | undefined): string[] {
  const newer = newerThan(releases, running).map((release) => release.imageTag);
  const back = previous && previous !== running && releases.some((release) => release.imageTag === previous) ? [previous] : [];
  return [...newer, ...back.filter((tag) => !newer.includes(tag))];
}

export function updateTarget(setting: UpdateSetting, running: string | undefined, current: string, releases: readonly InstanceRelease[]): string {
  if (!setting.auto) return setting.picked ?? running ?? current;
  if (!running) return current;
  return newerThan(releases, running).some((release) => release.imageTag === current) ? current : running;
}

export function findRelease(releases: readonly InstanceRelease[], name: string): InstanceRelease | undefined {
  return releases.find((release) => release.version === name) ?? releases.find((release) => release.imageTag === name);
}

export function pickProblem(releases: readonly InstanceRelease[], running: string | undefined, previous: string | undefined, name: string): string | undefined {
  const release = findRelease(releases, name);
  if (!release) return `there is no release ${name}`;
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
