import { COOLING_OFF_DAYS, DAY_MS } from '../../platform/lib/dependency-rule.js';

export interface TrackedImage {
  image: string;
  host: string;
  repository: string;
  tag: string;
  pinned: string;
}

export interface SeenBuild {
  image: string;
  tag: string;
  pinned: string;
  digest: string;
  builtAt?: string | undefined;
  revision?: string | undefined;
}

export interface TrackedBuild extends SeenBuild {
  firstSeenAt: string;
  takeOn: string;
}

export function trackedImageOf(component: { name: string; source?: string | undefined; tracks?: string | undefined }): TrackedImage | undefined {
  if (!component.tracks || !component.source) return undefined;
  const at = /^([^/]+)\/(.+)@sha256:([0-9a-f]{64})$/.exec(component.source);
  if (!at) return undefined;
  return { image: component.name, host: at[1]!, repository: at[2]!, tag: component.tracks, pinned: at[3]! };
}

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function trackedBuilds(previous: readonly TrackedBuild[], seen: readonly SeenBuild[], now: Date): TrackedBuild[] {
  return seen.filter((build) => build.digest !== build.pinned).map((build) => {
    const firstSeenAt = previous.find((before) => before.image === build.image && before.digest === build.digest)?.firstSeenAt ?? now.toISOString();
    return { ...build, firstSeenAt, takeOn: dayOf(Date.parse(firstSeenAt) + COOLING_OFF_DAYS * DAY_MS) };
  });
}
