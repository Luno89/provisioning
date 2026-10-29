import { compareVersions, COOLING_OFF_DAYS, DAY_MS, fixOf } from '../../platform/lib/dependency-rule.js';
import type { ComponentKind, InventoryComponent, Severity } from '../../platform/index.js';

export const DEPENDENCY_WATCH_ID = 'dependency-watch';

export type FindingState = 'waiting' | 'due' | 'no-fix';

export interface FindingComponent {
  name: string;
  version: string;
  kind: ComponentKind;
  in?: string | undefined;
  where?: string | undefined;
}

export interface DependencyFinding {
  key: string;
  component: FindingComponent;
  advisory: { id: string; summary?: string | undefined; severity?: Severity | undefined };
  fix?: string | undefined;
  fixPublishedAt?: string | undefined;
  takeOn?: string | undefined;
  state: FindingState;
  releases: string[];
  instances: string[];
  firstSeenAt: string;
  told: { appeared?: string | undefined; due?: string | undefined };
}

export interface Sighting {
  component: FindingComponent;
  advisory: { id: string; summary?: string | undefined; severity?: Severity | undefined; fixed: string[] };
  releases: string[];
  instances: string[];
}

export interface CheckedRelease {
  release: string;
  label: string;
  instances: string[];
  root: boolean;
  components: number;
  inventory: boolean;
}

export interface ListedComponent {
  name: string;
  version?: string | undefined;
  kind: ComponentKind;
  in?: string | undefined;
  where?: string | undefined;
  dev: boolean;
  checked: boolean;
  publishedAt?: string | undefined;
}

export interface DependencyCheck {
  checkedAt: string;
  releases: CheckedRelease[];
  components: ListedComponent[];
  problems: string[];
}

export type Telling = { finding: DependencyFinding; why: 'appeared' | 'due' };

export const findingKey = (component: FindingComponent, advisoryId: string): string =>
  `${component.in ?? component.kind}:${component.name}@${component.version}${component.where ? `#${component.where}` : ''}|${advisoryId}`;

export const componentOf = (component: InventoryComponent): FindingComponent => ({
  name: component.name,
  version: component.version ?? '',
  kind: component.kind,
  ...(component.in ? { in: component.in } : {}),
  ...(component.where ? { where: component.where } : {}),
});

const fixFor = (sighting: Sighting): string | undefined =>
  fixOf({ id: sighting.advisory.id, name: sighting.component.name, version: sighting.component.version.replace(/^v/, ''), fixed: sighting.advisory.fixed });

export function judged(sighting: Sighting, publishedAt: (sighting: Sighting, fix: string) => string | undefined, now: Date, days = COOLING_OFF_DAYS): Pick<DependencyFinding, 'fix' | 'fixPublishedAt' | 'takeOn' | 'state'> {
  const fix = fixFor(sighting);
  if (!fix) return { state: 'no-fix' };
  const published = publishedAt(sighting, fix);
  if (!published) return { fix, state: 'due' };
  const takeOn = new Date(Date.parse(published) + days * DAY_MS);
  return { fix, fixPublishedAt: published, takeOn: takeOn.toISOString().slice(0, 10), state: takeOn.getTime() > now.getTime() ? 'waiting' : 'due' };
}

export function mergeFindings(
  previous: readonly DependencyFinding[],
  sightings: readonly Sighting[],
  publishedAt: (sighting: Sighting, fix: string) => string | undefined,
  now: Date,
): { findings: DependencyFinding[]; tell: Telling[]; resolved: DependencyFinding[] } {
  const before = new Map(previous.map((finding) => [finding.key, finding]));
  const at = now.toISOString();
  const tell: Telling[] = [];
  const findings = sightings.map((sighting) => {
    const key = findingKey(sighting.component, sighting.advisory.id);
    const known = before.get(key);
    const state = judged(sighting, publishedAt, now);
    const finding: DependencyFinding = {
      key,
      component: sighting.component,
      advisory: { id: sighting.advisory.id, ...(sighting.advisory.summary ? { summary: sighting.advisory.summary } : {}), ...(sighting.advisory.severity ? { severity: sighting.advisory.severity } : {}) },
      ...state,
      releases: [...sighting.releases].sort(),
      instances: [...sighting.instances].sort(),
      firstSeenAt: known?.firstSeenAt ?? at,
      told: { ...(known?.told ?? {}) },
    };
    if (!finding.told.appeared) {
      finding.told.appeared = at;
      if (finding.state === 'due') finding.told.due = at;
      tell.push({ finding, why: 'appeared' });
    } else if (finding.state === 'due' && !finding.told.due) {
      finding.told.due = at;
      tell.push({ finding, why: 'due' });
    }
    return finding;
  });
  const current = new Set(findings.map((finding) => finding.key));
  return { findings, tell, resolved: previous.filter((finding) => !current.has(finding.key)) };
}

const STATE_SAID: Record<FindingState, (finding: DependencyFinding) => string> = {
  'due': (finding) => `fixed in ${finding.fix}${finding.fixPublishedAt ? `, published ${finding.fixPublishedAt.slice(0, 10)}` : ''}: update it now`,
  'waiting': (finding) => `fixed in ${finding.fix}, which can be taken on ${finding.takeOn}`,
  'no-fix': () => 'no fixed version yet',
};

const lineOf = ({ finding, why }: Telling): string =>
  `- ${finding.component.name}@${finding.component.version}${finding.component.in && finding.component.in !== 'koala' ? ` (in ${finding.component.in})` : ''}: ${finding.advisory.id}${finding.advisory.severity ? ` (${finding.advisory.severity})` : ''}${why === 'due' ? ', its fix is now two weeks old' : ''}; ${STATE_SAID[finding.state](finding)}. Running in ${finding.releases.join(', ')}${finding.instances.length ? ` on ${finding.instances.length} instance${finding.instances.length === 1 ? '' : 's'}` : ''}.`;

export function tellingMessage(tell: readonly Telling[], rootUrl: string): { subject: string; text: string } | undefined {
  if (tell.length === 0) return undefined;
  const fresh = tell.filter((entry) => entry.why === 'appeared').length;
  const due = tell.length - fresh;
  const parts = [fresh ? `${fresh} new advisor${fresh === 1 ? 'y' : 'ies'}` : '', due ? `${due} fix${due === 1 ? '' : 'es'} now due` : ''].filter(Boolean);
  return {
    subject: `Koala's dependencies: ${parts.join(', ')}`,
    text: [
      `Koala's daily check of what its running releases are made of found:`,
      '',
      ...tell.map(lineOf),
      '',
      `A fix is taken once it is ${COOLING_OFF_DAYS} days old (npm run deps:update -- <package>, then a release); one that is reachable in Koala can be taken by hand sooner.`,
      ...(rootUrl ? [`See them all: ${rootUrl}/#/admin`] : []),
    ].join('\n'),
  };
}

export function fixingRelease(finding: DependencyFinding, releases: readonly { release: string; label: string; components: readonly InventoryComponent[] }[]): string | undefined {
  if (!finding.fix) return undefined;
  const fix = finding.fix;
  const fixes = releases.filter(({ components }) => components.some((component) =>
    component.name === finding.component.name && component.kind === finding.component.kind && (component.in ?? '') === (finding.component.in ?? '')
    && component.version !== undefined && compareVersions(component.version.replace(/^v/, ''), fix) >= 0));
  return fixes.at(-1)?.label;
}
