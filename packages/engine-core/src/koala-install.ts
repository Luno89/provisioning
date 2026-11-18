import { progressOf, type MachineProgress, type ProgressContract } from './machine-progress.js';

export const KOALA_INSTALL_STAGES = ['cluster', 'chart', 'koala'] as const;

export type KoalaInstallStage = (typeof KOALA_INSTALL_STAGES)[number];

export const KOALA_INSTALL_LAST_STAGE: KoalaInstallStage = 'koala';

export const KOALA_INSTALL_PROGRESS: ProgressContract = { lines: true, lastStage: KOALA_INSTALL_LAST_STAGE };

export const KOALA_INSTALL_ROUTE = '/koala-installs/:installId/progress';

export const koalaInstallProgressPath = (installId: string): string => `/api/machines/koala-installs/${encodeURIComponent(installId)}/progress`;

export const PLACE_KOALA = 'machine:place-koala';

export const KOALA_INSTALL_CHANGED = 'koala-install-changed';

export const KOALA_INSTALL_STATES = ['asked', 'installing', 'ready', 'failed'] as const;

export type KoalaInstallState = (typeof KOALA_INSTALL_STATES)[number];

export interface PlacedKoala {
  installId: string;
  instanceId: string;
  ownerId: string;
  machineId: string;
  rootUrl: string;
  rootPublicKeys: string;
  meshLoginServer: string;
  meshAddress: string;
  image: string;
  imageTag: string;
  imageDigest?: string | undefined;
  chartUrl: string;
  chartSha256?: string | undefined;
  credential: string;
  name: string;
  domain: string;
}

export interface KoalaInstallView {
  id: string;
  machineId: string;
  state: KoalaInstallState;
  stage?: string;
  title?: string;
  line?: string;
  why?: string;
  at: string;
}

export const PROVISION_PIECES = [
  { key: 'egress', title: 'The egress proxy' },
  { key: 'searxng', title: 'SearXNG, web search' },
  { key: 'crawl4ai', title: 'Crawl4AI, page reading' },
  { key: 'gitea', title: 'Gitea, your repositories and images' },
  { key: 'verdaccio', title: 'The npm registry mirror' },
  { key: 'infisical', title: 'Infisical, your secrets' },
  { key: 'monitoring', title: 'Monitoring' },
] as const;

export type ProvisionPieceKey = (typeof PROVISION_PIECES)[number]['key'];

export const PROVISION_DONE_STAGE = 'set-up';

export const PROVISION_DONE_TITLE = 'Koala is set up';

export const PROVISION_PROGRESS: ProgressContract = { lines: true };

export const PROVISIONING_CHANGED = 'provisioning-changed';

export const PROVISION_PIECE_STATES = ['waiting', 'working', 'up', 'failed'] as const;

export type ProvisionPieceState = (typeof PROVISION_PIECE_STATES)[number];

export const PROVISION_RUN_STATES = ['running', 'up', 'failed'] as const;

export type ProvisionRunState = (typeof PROVISION_RUN_STATES)[number];

export const PROVISION_REASONS = ['revision', 'missing', 'asked'] as const;

export type ProvisionReason = (typeof PROVISION_REASONS)[number];

export type ProvisionTarget =
  | { kind: 'koala'; clusterId: string }
  | { kind: 'machine'; clusterId: string; machine: string };

export interface ProvisionPieceView {
  key: ProvisionPieceKey;
  title: string;
  state: ProvisionPieceState;
  line?: string;
  why?: string;
  at?: string;
}

export interface ProvisioningView {
  id: string;
  target: ProvisionTarget;
  revision: number;
  reason: ProvisionReason;
  state: ProvisionRunState;
  pieces: ProvisionPieceView[];
  startedAt: string;
  endedAt?: string;
  why?: string;
}

export interface ProvisionReport {
  revision: number;
  progress: MachineProgress;
}

export type ProvisionReportRead = { ok: true; value: ProvisionReport } | { ok: false; problem: string };

const REPORT_KEYS = ['revision', 'progress'];
const STAGES: readonly string[] = [...PROVISION_PIECES.map((piece) => piece.key), PROVISION_DONE_STAGE];
const finished = (progress: MachineProgress): boolean => progress.state === 'done' || progress.state === 'already-done';

export function provisionReportOf(raw: unknown): ProvisionReportRead {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'send an object with "revision" and "progress"' };
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => !REPORT_KEYS.includes(key));
  if (extra.length > 0) return { ok: false, problem: `only "revision" and "progress" are taken, not ${extra.map((key) => `"${key}"`).join(', ')}` };
  if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 1) return { ok: false, problem: '"revision" is the chart revision the setup is for, a whole number from 1' };
  const read = progressOf(body.progress, PROVISION_PROGRESS);
  if (!read.ok) return read;
  if (!STAGES.includes(read.value.stage)) return { ok: false, problem: `"stage" is one of ${STAGES.slice(0, -1).join(', ')} or ${PROVISION_DONE_STAGE}` };
  if (read.value.stage === PROVISION_DONE_STAGE && !finished(read.value)) return { ok: false, problem: `the "${PROVISION_DONE_STAGE}" stage is only ever done: a piece that fails says so itself` };
  return { ok: true, value: { revision: body.revision, progress: read.value } };
}

export type ProvisionEnding = 'up' | 'failed';

export function provisionEnding(progress: MachineProgress): ProvisionEnding | undefined {
  if (progress.state === 'failed') return 'failed';
  return progress.stage === PROVISION_DONE_STAGE && finished(progress) ? 'up' : undefined;
}
