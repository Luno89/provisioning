import { answerFailure, advisoryFor, batches, failureOf, checkedByOsv, idsFromBatch, inventoryComponents, queryKey, queryOf, type DependencySources, type InventoryComponent, type OsvQuery } from '../../platform/index.js';
import {
  componentOf, findingKey, fixFor, fixingRelease, mergeFindings, runtimeFindings, tellingMessage,
  type CheckedRelease, type DependencyCheck, type DependencyFinding, type ListedComponent, type Sighting,
} from '../lib/dependency-findings.js';
import type { InstanceRelease } from '../lib/instance-updates.js';
import { goneImages, goneMessage, manifestAnswer, MANIFESTS, pinnedImageOf, registryReachOf, shortDigest, type DigestSeen, type PinnedImage } from '../lib/pinned-images.js';
import { trackedBuilds, trackedImageOf, type SeenBuild, type TrackedImage } from '../lib/tracked-builds.js';
import type { InstancesStore } from '../store.js';

export interface DependencyWatchDeps {
  store: Pick<InstancesStore, 'getReleases' | 'getInstances' | 'getDependencyFindings' | 'saveDependencyFindings' | 'getDependencyCheck' | 'saveDependencyCheck'>;
  inventoryOf: (imageTag: string) => Promise<unknown | undefined>;
  currentRelease: string;
  fetchImpl: typeof fetch;
  sources: DependencySources;
  tell: (message: { subject: string; text: string }) => Promise<void>;
  rootUrl: string;
  now?: () => Date;
}

export interface WatchView {
  check?: DependencyCheck | undefined;
  findings: DependencyFinding[];
}

export interface ReleaseFindings {
  release: string;
  findings: (Pick<DependencyFinding, 'component' | 'advisory' | 'state' | 'fix' | 'takeOn'> & { fixedBy?: string | undefined })[];
}

const labelOf = (release: InstanceRelease | undefined, imageTag: string): string => release?.version ?? imageTag;

const npmPath = (name: string): string => (name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name));

export class DependencyWatch {
  constructor(private readonly deps: DependencyWatchDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async json(url: string, init?: RequestInit): Promise<unknown | undefined> {
    const response = await this.deps.fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  }

  private async watchedReleases(): Promise<{ release: string; label: string; instances: string[]; root: boolean; servedAt?: string | undefined }[]> {
    const releases = await this.deps.store.getReleases();
    const instances = await this.deps.store.getInstances();
    const running = new Map<string, string[]>();
    for (const instance of instances) {
      if (!instance.running) continue;
      running.set(instance.running, [...(running.get(instance.running) ?? []), instance.name ?? instance.id]);
    }
    const tags = new Set([this.deps.currentRelease, ...running.keys()]);
    return [...tags].map((tag) => {
      const record = releases.find((entry) => entry.imageTag === tag);
      return { release: tag, label: labelOf(record, tag), instances: running.get(tag) ?? [], root: tag === this.deps.currentRelease, servedAt: record?.servedAt };
    }).sort((a, b) => (a.servedAt ?? '').localeCompare(b.servedAt ?? ''));
  }

  private async advisoryIds(queries: readonly OsvQuery[]): Promise<string[][]> {
    const ids: string[][] = [];
    for (const batch of batches(queries)) {
      const answer = await this.json(`${this.deps.sources.osv}/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: batch }) });
      ids.push(...idsFromBatch(answer, batch.length));
    }
    return ids;
  }

  private async npmTimes(name: string): Promise<Record<string, string> | undefined> {
    const doc = await this.json(`${this.deps.sources.npm}/${npmPath(name)}`) as { time?: Record<string, string> } | undefined;
    return doc?.time;
  }

  private async githubRelease(repo: string, version: string): Promise<string | undefined> {
    for (const tag of version.startsWith('v') ? [version] : [`v${version}`, version]) {
      const found = await this.json(`${this.deps.sources.github}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`).catch((err: Error) => {
        console.warn(`[dependencies] when ${repo} released ${tag} could not be read, so it stays unknown until the next check: ${err.message}`);
        return undefined;
      }) as { published_at?: string } | undefined;
      if (found?.published_at) return found.published_at;
    }
    return undefined;
  }

  private reachOf(host: string, repository: string) {
    const reach = registryReachOf(host, repository, this.deps.sources);
    if (!reach) throw new Error(`Koala asks only docker.io and ghcr.io, and it is on ${host}`);
    return reach;
  }

  private async digestState(image: PinnedImage): Promise<'present' | 'gone'> {
    const reach = this.reachOf(image.host, image.repository);
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        throw new Error(`asking ${what}, ${failureOf(err).reason}`);
      }
    };
    const token = await step(`${image.host}'s token service`, async () => {
      const response = await this.deps.fetchImpl(reach.token, { headers: { accept: 'application/json' } });
      if (!response.ok) throw answerFailure(response.status, response.headers.get('retry-after'));
      const answer = await response.json() as { token?: unknown; access_token?: unknown };
      const given = typeof answer.token === 'string' ? answer.token : answer.access_token;
      if (typeof given !== 'string' || !given) throw new Error('it gave no token');
      return given;
    });
    return step(`${image.host} for its manifest`, async () => {
      const response = await this.deps.fetchImpl(`${reach.registry}/v2/${image.repository}/manifests/sha256:${image.digest}`, { headers: { authorization: `Bearer ${token}`, accept: MANIFESTS } });
      const text = await response.text();
      let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
      const state = manifestAnswer(response.status, body);
      if (!state) throw answerFailure(response.status, response.headers.get('retry-after'));
      return state;
    });
  }

  private async pinnedDigests(watched: readonly { release: string; label: string }[], inventories: ReadonlyMap<string, InventoryComponent[]>, problems: string[]): Promise<DigestSeen[]> {
    const pinned = new Map<string, { pinned: PinnedImage; releases: string[] }>();
    for (const release of watched) {
      for (const component of inventories.get(release.release) ?? []) {
        const image = pinnedImageOf(component);
        if (!image) continue;
        const key = `${image.image}@${image.digest}`;
        const entry = pinned.get(key) ?? { pinned: image, releases: [] };
        if (!entry.releases.includes(release.label)) entry.releases.push(release.label);
        pinned.set(key, entry);
      }
    }
    const seen: DigestSeen[] = [];
    for (const entry of pinned.values()) {
      try {
        seen.push({ ...entry, state: await this.digestState(entry.pinned) });
      } catch (err) {
        problems.push(`whether ${entry.pinned.image}@${shortDigest(entry.pinned.digest)} is still published could not be checked: ${(err as Error).message}`);
        seen.push({ ...entry, state: 'unchecked' });
      }
    }
    return seen;
  }

  private async newestBuild(image: TrackedImage): Promise<SeenBuild> {
    const { registry, token: tokenUrl } = this.reachOf(image.host, image.repository);
    const { token } = await this.json(tokenUrl) as { token: string };
    const ask = async (path: string, accept: string) => {
      const response = await this.deps.fetchImpl(`${registry}/v2/${image.repository}/${path}`, { headers: { authorization: `Bearer ${token}`, accept } });
      if (!response.ok) throw new Error(`${registry}/v2/${image.repository}/${path} answered ${response.status}`);
      return { digest: response.headers.get('docker-content-digest'), body: await response.json() as Record<string, unknown> };
    };
    const tagged = await ask(`manifests/${image.tag}`, MANIFESTS);
    if (!tagged.digest?.startsWith('sha256:')) throw new Error(`${registry} named no digest for ${image.repository}:${image.tag}`);
    const amd64 = (tagged.body.manifests as { digest: string; platform?: { os?: string; architecture?: string } }[] | undefined)?.find((entry) => entry.platform?.os === 'linux' && entry.platform.architecture === 'amd64');
    const manifest = amd64 ? (await ask(`manifests/${amd64.digest}`, MANIFESTS)).body : tagged.body;
    const configDigest = (manifest.config as { digest?: string } | undefined)?.digest;
    if (!configDigest) throw new Error(`${image.repository}:${image.tag} names no image config`);
    const labels = ((await ask(`blobs/${configDigest}`, 'application/json')).body.config as { Labels?: Record<string, string> } | undefined)?.Labels ?? {};
    return {
      image: image.image,
      tag: image.tag,
      pinned: image.pinned,
      digest: tagged.digest.slice('sha256:'.length),
      ...(labels['org.opencontainers.image.created'] ? { builtAt: labels['org.opencontainers.image.created'] } : {}),
      ...(labels['org.opencontainers.image.revision'] ? { revision: labels['org.opencontainers.image.revision'] } : {}),
    };
  }

  async check(): Promise<WatchView> {
    const now = this.now();
    const problems: string[] = [];
    const watched = await this.watchedReleases();
    const inventories = new Map<string, InventoryComponent[]>();
    for (const release of watched) {
      const bom = await this.deps.inventoryOf(release.release);
      if (bom === undefined) problems.push(`no inventory is kept for ${release.label}, so it was not checked`);
      inventories.set(release.release, inventoryComponents(bom));
    }

    const byQuery = new Map<string, { query: OsvQuery; seen: { release: string; component: InventoryComponent }[] }>();
    for (const [release, components] of inventories) {
      for (const component of components.filter(checkedByOsv)) {
        const query = queryOf(component);
        const key = queryKey(query);
        const entry = byQuery.get(key) ?? { query, seen: [] };
        entry.seen.push({ release, component });
        byQuery.set(key, entry);
      }
    }
    const asked = [...byQuery.values()];
    const ids = await this.advisoryIds(asked.map((entry) => entry.query));

    const records = new Map<string, unknown>();
    for (const id of new Set(ids.flat())) records.set(id, await this.json(`${this.deps.sources.osv}/vulns/${encodeURIComponent(id)}`));

    const instancesOf = new Map(watched.map((release) => [release.release, release.instances]));
    const labelOfRelease = new Map(watched.map((release) => [release.release, release.label]));
    const sightings = new Map<string, Sighting & { source: InventoryComponent }>();
    asked.forEach((entry, at) => {
      for (const id of ids[at] ?? []) {
        const advisory = advisoryFor(records.get(id), entry.query);
        if (!advisory) continue;
        for (const { release, component } of entry.seen) {
          const found = componentOf(component);
          const key = findingKey(found, advisory.id);
          const sighting = sightings.get(key) ?? { component: found, advisory, releases: [], instances: [], source: component, devOnly: component.dev };
          sighting.devOnly = Boolean(sighting.devOnly) && component.dev;
          sighting.releases = [...new Set([...sighting.releases, labelOfRelease.get(release) ?? release])];
          sighting.instances = [...new Set([...sighting.instances, ...(instancesOf.get(release) ?? [])])];
          sightings.set(key, sighting);
        }
      }
    });

    const previous = await this.deps.store.getDependencyFindings();
    const kept = new Map(previous.flatMap((finding) => (finding.fix && finding.fixPublishedAt ? [[`${finding.key}|${finding.fix}`, finding.fixPublishedAt] as const] : [])));
    const dates = new Map<string, string | undefined>();
    const dateKey = (component: InventoryComponent, fix: string) => `${component.ecosystem}|${component.osvName}|${fix}`;
    const npmTimes = new Map<string, Record<string, string> | undefined>();
    for (const [key, sighting] of sightings) {
      const { source } = sighting;
      const fix = fixFor(sighting);
      if (!fix || dates.get(dateKey(source, fix))) continue;
      const known = kept.get(`${key}|${fix}`);
      if (known) {
        dates.set(dateKey(source, fix), known);
        continue;
      }
      if (dates.has(dateKey(source, fix))) continue;
      if (source.ecosystem === 'npm') {
        if (!npmTimes.has(source.name)) npmTimes.set(source.name, await this.npmTimes(source.name).catch((err: Error) => {
          console.warn(`[dependencies] when ${source.name}'s versions were published could not be read, so its fixes stay undated until the next check: ${err.message}`);
          return undefined;
        }));
        dates.set(dateKey(source, fix), npmTimes.get(source.name)?.[fix]);
      } else {
        dates.set(dateKey(source, fix), source.github ? await this.githubRelease(source.github, fix) : undefined);
      }
    }
    const sourceOf = new Map([...sightings.entries()].map(([key, sighting]) => [key, sighting.source]));
    const merged = mergeFindings(previous, [...sightings.values()], (sighting, fix) => {
      const source = sourceOf.get(findingKey(sighting.component, sighting.advisory.id));
      return source ? dates.get(dateKey(source, fix)) : undefined;
    }, now);
    await this.deps.store.saveDependencyFindings(merged.findings);
    const message = tellingMessage(merged.tell, this.deps.rootUrl);
    if (message) await this.deps.tell(message);

    const previousCheck = await this.deps.store.getDependencyCheck();
    const digests = goneImages(previousCheck?.gone ?? [], await this.pinnedDigests(watched, inventories, problems), now);

    const current = inventories.get(this.deps.currentRelease) ?? [];
    const seen: SeenBuild[] = [];
    for (const image of current.flatMap((component) => { const tracked = trackedImageOf(component); return tracked ? [tracked] : []; })) {
      try {
        seen.push(await this.newestBuild(image));
      } catch (err) {
        problems.push(`the newest build of ${image.image}:${image.tag} could not be read: ${(err as Error).message}`);
      }
    }
    const builds = trackedBuilds(previousCheck?.builds ?? [], seen, now);
    const components: ListedComponent[] = current.map((component) => ({
      name: component.name,
      version: component.version,
      kind: component.kind,
      ...(component.in ? { in: component.in } : {}),
      ...(component.where ? { where: component.where } : {}),
      dev: component.dev,
      checked: checkedByOsv(component),
      ...(component.released ? { publishedAt: component.released } : {}),
    }));
    const releases: CheckedRelease[] = watched.map((release) => ({
      release: release.release,
      label: release.label,
      instances: release.instances,
      root: release.root,
      components: inventories.get(release.release)?.length ?? 0,
      inventory: (inventories.get(release.release)?.length ?? 0) > 0,
    }));
    const check: DependencyCheck = { checkedAt: now.toISOString(), releases, components, builds, gone: digests.gone, problems };
    await this.deps.store.saveDependencyCheck(check);
    const goneTelling = goneMessage(digests.fresh, this.deps.rootUrl);
    if (goneTelling) await this.deps.tell(goneTelling);
    return { check, findings: merged.findings };
  }

  async view(): Promise<WatchView> {
    return { check: await this.deps.store.getDependencyCheck(), findings: await this.deps.store.getDependencyFindings() };
  }

  async forRelease(imageTag: string): Promise<ReleaseFindings> {
    const releases = (await this.deps.store.getReleases()).sort((a, b) => (a.servedAt ?? '').localeCompare(b.servedAt ?? ''));
    const record = releases.find((release) => release.imageTag === imageTag);
    const label = labelOf(record, imageTag);
    const findings = runtimeFindings(await this.deps.store.getDependencyFindings()).filter((finding) => finding.releases.includes(label));
    const newer = record ? releases.filter((release) => (release.servedAt ?? '') > (record.servedAt ?? '')) : [];
    const candidates: { release: string; label: string; components: InventoryComponent[] }[] = [];
    for (const release of newer) candidates.push({ release: release.imageTag, label: labelOf(release, release.imageTag), components: inventoryComponents(await this.deps.inventoryOf(release.imageTag)) });
    return {
      release: label,
      findings: findings.map((finding) => ({
        component: finding.component,
        advisory: finding.advisory,
        state: finding.state,
        ...(finding.fix ? { fix: finding.fix } : {}),
        ...(finding.takeOn ? { takeOn: finding.takeOn } : {}),
        ...(fixingRelease(finding, candidates) ? { fixedBy: fixingRelease(finding, candidates) } : {}),
      })),
    };
  }
}
