import type { OdooRelease } from '../../releases/lib/odoo-release.js';
import type { PipelineRunMetadata } from '../../platform/index.js';
import { changesSentence } from '../../releases/lib/release-compare.js';
import { importLine, type ClientImport } from '../../releases/lib/client-import.js';

export type StatusProject = { id: string; name: string; clientImport?: ClientImport | undefined };
export type StatusRelease = Pick<OdooRelease, 'commit' | 'slot' | 'state' | 'reason' | 'liveAt' | 'startedAt' | 'updatedAt' | 'changes'>;
export type StatusRun = Pick<PipelineRunMetadata, 'commitSha' | 'status' | 'startedAt' | 'finishedAt' | 'promotedAt' | 'errorMessage' | 'releaseSkipped' | 'releaseRefused' | 'releaseHeld'>;

const PREPARING: ReadonlySet<OdooRelease['state']> = new Set(['preparing', 'cutting-over', 'rolling-back']);

const short = (commit: string) => commit.slice(0, 8);
const when = (at: string) => `${at.slice(0, 16).replace('T', ' ')} UTC`;
const newest = <T extends { startedAt: string }>(items: readonly T[]): T | undefined =>
  [...items].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

export function projectOutline(project: StatusProject, releases: readonly StatusRelease[], runs: readonly StatusRun[]): string {
  const live = newest(releases.filter((release) => release.state === 'live'));
  const deployed = live ? undefined : newest(runs.filter((run) => run.promotedAt !== undefined));
  const preview = newest(releases.filter((release) => release.state === 'preview'));
  const preparing = newest(releases.filter((release) => PREPARING.has(release.state)));
  const build = newest(runs);

  const lines = [
    `Project "${project.name}" (${project.id}).`,
    live
      ? `Live: ${short(live.commit)}${live.slot ? ` in slot ${live.slot}` : ''}, since ${when(live.liveAt ?? live.updatedAt)}.`
      : deployed
        ? `Live: ${short(deployed.commitSha)}, deployed ${when(deployed.promotedAt!)}.`
        : 'Live: nothing yet.',
    preview
      ? `Waiting for the person: ${short(preview.commit)} is ready to preview${preview.slot ? ` in slot ${preview.slot}` : ''}.${preview.changes ? ` ${changesSentence(preview.changes)}` : ''} Cutting over or discarding it is theirs, on the project's board; tell them it is there rather than doing it.`
      : '',
    preparing ? `In progress: ${short(preparing.commit)} is ${preparing.state}.` : '',
    build
      ? `Last build: ${build.status}, ${short(build.commitSha)}, ${when(build.finishedAt ?? build.startedAt)}${build.errorMessage ? `: ${build.errorMessage}` : ''}${build.releaseSkipped ? `; not released: ${build.releaseSkipped}` : ''}${build.releaseRefused ? `; release refused: ${build.releaseRefused}` : ''}${build.releaseHeld ? `; held: ${build.releaseHeld}` : ''}.`
      : 'Last build: none yet.',
    importLine(project.clientImport),
    'Earlier releases: project_releases.',
  ];
  return lines.filter(Boolean).join('\n');
}
