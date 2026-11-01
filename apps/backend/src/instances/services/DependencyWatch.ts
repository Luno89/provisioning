import { advisoryFor, batches, checkedByOsv, idsFromBatch, inventoryComponents, OSV_API, queryKey, queryOf, type InventoryComponent, type OsvQuery } from '../../platform/index.js';
import {
  componentOf, findingKey, fixingRelease, mergeFindings, runtimeFindings, tellingMessage,
  type CheckedRelease, type DependencyCheck, type DependencyFinding, type ListedComponent, type Sighting,
} from '../lib/dependency-findings.js';
import type { InstanceRelease } from '../lib/instance-updates.js';
import type { InstancesStore } from '../store.js';

export interface DependencyWatchDeps {
  store: Pick<InstancesStore, 'getReleases' | 'getInstances' | 'getDependencyFindings' | 'saveDependencyFindings' | 'getDependencyCheck' | 'saveDependencyCheck'>;
  inventoryOf: (imageTag: string) => Promise<unknown | undefined>;
  currentRelease: string;
  fetchImpl: typeof fetch;
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
      const answer = await this.json(`${OSV_API}/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: batch }) });
      ids.push(...idsFromBatch(answer, batch.length));
    }
    return ids;
  }

  private async npmTimes(name: string): Promise<Record<string, string> | undefined> {
    const doc = await this.json(`https://registry.npmjs.org/${npmPath(name)}`) as { time?: Record<string, string> } | undefined;
    return doc?.time;
  }

  private async githubRelease(repo: string, version: string): Promise<string | undefined> {
    for (const tag of version.startsWith('v') ? [version] : [`v${version}`, version]) {
      const found = await this.json(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`).catch((err: Error) => {
        console.warn(`[dependencies] when ${repo} released ${tag} could not be read, so it stays unknown until the next check: ${err.message}`);
        return undefined;
      }) as { published_at?: string } | undefined;
      if (found?.published_at) return found.published_at;
    }
    return undefined;
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
    for (const id of new Set(ids.flat())) records.set(id, await this.json(`${OSV_API}/vulns/${encodeURIComponent(id)}`));

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

    const dates = new Map<string, string | undefined>();
    const dateKey = (component: InventoryComponent, fix: string) => `${component.ecosystem}|${component.osvName}|${fix}`;
    const npmTimes = new Map<string, Record<string, string> | undefined>();
    for (const sighting of sightings.values()) {
      const { source } = sighting;
      for (const fix of sighting.advisory.fixed) {
        const key = dateKey(source, fix);
        if (dates.has(key)) continue;
        if (source.ecosystem === 'npm') {
          if (!npmTimes.has(source.name)) npmTimes.set(source.name, await this.npmTimes(source.name).catch((err: Error) => {
            console.warn(`[dependencies] when ${source.name}'s versions were published could not be read, so its fixes stay undated until the next check: ${err.message}`);
            return undefined;
          }));
          dates.set(key, npmTimes.get(source.name)?.[fix]);
        } else {
          dates.set(key, source.github ? await this.githubRelease(source.github, fix) : undefined);
        }
      }
    }
    const sourceOf = new Map([...sightings.entries()].map(([key, sighting]) => [key, sighting.source]));
    const previous = await this.deps.store.getDependencyFindings();
    const merged = mergeFindings(previous, [...sightings.values()], (sighting, fix) => {
      const source = sourceOf.get(findingKey(sighting.component, sighting.advisory.id));
      return source ? dates.get(dateKey(source, fix)) : undefined;
    }, now);
    await this.deps.store.saveDependencyFindings(merged.findings);
    const message = tellingMessage(merged.tell, this.deps.rootUrl);
    if (message) await this.deps.tell(message);

    const current = inventories.get(this.deps.currentRelease) ?? [];
    const ages = new Map<string, string | undefined>();
    for (const component of current) {
      if (component.kind === 'npm' || !component.github || !component.version || ages.has(component.ref)) continue;
      ages.set(component.ref, await this.githubRelease(component.github, component.version));
    }
    const components: ListedComponent[] = current.map((component) => ({
      name: component.name,
      version: component.version,
      kind: component.kind,
      ...(component.in ? { in: component.in } : {}),
      ...(component.where ? { where: component.where } : {}),
      dev: component.dev,
      checked: checkedByOsv(component),
      ...(ages.get(component.ref) ? { publishedAt: ages.get(component.ref) } : {}),
    }));
    const releases: CheckedRelease[] = watched.map((release) => ({
      release: release.release,
      label: release.label,
      instances: release.instances,
      root: release.root,
      components: inventories.get(release.release)?.length ?? 0,
      inventory: (inventories.get(release.release)?.length ?? 0) > 0,
    }));
    const check: DependencyCheck = { checkedAt: now.toISOString(), releases, components, problems };
    await this.deps.store.saveDependencyCheck(check);
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
