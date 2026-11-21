import { progressOf, type MachineProgress, type ProgressContract } from './machine-progress.js';

export const KOALA_INSTALL_STAGES = ['cluster', 'chart', 'koala'] as const;

export type KoalaInstallStage = (typeof KOALA_INSTALL_STAGES)[number];

export const KOALA_INSTALL_LAST_STAGE: KoalaInstallStage = 'koala';

export const KOALA_INSTALL_PROGRESS: ProgressContract = { lines: true, lastStage: KOALA_INSTALL_LAST_STAGE };

export const KOALA_INSTALL_ROUTE = '/koala-installs/:installId/progress';

export const koalaInstallProgressPath = (installId: string): string => `/api/machines/koala-installs/${encodeURIComponent(installId)}/progress`;

export const KOALA_INSTALL_FOLLOW_ROUTE = '/koala-installs/following';

export const KOALA_INSTALL_FOLLOW_PATH = `/api/machines${KOALA_INSTALL_FOLLOW_ROUTE}`;

export const KOALA_INSTALL_FOLLOW_STOPPED = 'stopped';

export const KOALA_INSTALL_FOLLOW_BEAT_MS = 15_000;

export const PLACE_KOALA = 'machine:place-koala';

export const STOP_KOALA = 'machine:stop-koala';

export interface KoalaStop {
  installId: string;
}

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
  registrationCode: string;
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

export interface KoalaInstallFollowed {
  install: KoalaInstallView;
  url?: string;
}

export type KoalaInstallFollowedRead = { ok: true; value: KoalaInstallFollowed } | { ok: false; problem: string };

export const koalaInstallEnded = (install: Pick<KoalaInstallView, 'state'>): boolean => install.state === 'ready' || install.state === 'failed';

const VIEW_TEXT = ['id', 'machineId', 'at'] as const;
const VIEW_OPTIONAL_TEXT = ['stage', 'title', 'line', 'why'] as const;
const VIEW_KEYS: readonly string[] = ['id', 'machineId', 'state', ...VIEW_OPTIONAL_TEXT, 'at'];
const FOLLOWED_KEYS = ['install', 'url'];
const isObject = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const quotedList = (names: readonly string[]): string => `${names.slice(0, -1).map((name) => `"${name}"`).join(', ')} and "${names[names.length - 1]}"`;

function installViewProblem(raw: Record<string, unknown>): string | undefined {
  const extra = Object.keys(raw).filter((key) => !VIEW_KEYS.includes(key));
  if (extra.length > 0) return `an install has only ${quotedList(VIEW_KEYS)}, not ${extra.map((key) => `"${key}"`).join(', ')}`;
  const missing = VIEW_TEXT.find((key) => !nonEmpty(raw[key]));
  if (missing) return `"${missing}" is a non-empty string`;
  if (!KOALA_INSTALL_STATES.includes(raw.state as KoalaInstallState)) return `"state" is one of ${KOALA_INSTALL_STATES.join(', ')}`;
  const wrong = VIEW_OPTIONAL_TEXT.find((key) => raw[key] !== undefined && !nonEmpty(raw[key]));
  if (wrong) return `"${wrong}" is a non-empty string`;
  return undefined;
}

export function koalaInstallFollowedOf(raw: unknown): KoalaInstallFollowedRead {
  if (!isObject(raw)) return { ok: false, problem: 'send an object with "install"' };
  const extra = Object.keys(raw).filter((key) => !FOLLOWED_KEYS.includes(key));
  if (extra.length > 0) return { ok: false, problem: `only ${quotedList(FOLLOWED_KEYS)} are taken, not ${extra.map((key) => `"${key}"`).join(', ')}` };
  if (!isObject(raw.install)) return { ok: false, problem: '"install" is an object' };
  const problem = installViewProblem(raw.install);
  if (problem) return { ok: false, problem };
  if (raw.url !== undefined) {
    if (!nonEmpty(raw.url)) return { ok: false, problem: '"url" is a non-empty string' };
    if (raw.install.state !== 'ready') return { ok: false, problem: 'only a ready install says where Koala answers' };
  }
  const install = raw.install as unknown as KoalaInstallView;
  return { ok: true, value: { install, ...(raw.url !== undefined ? { url: raw.url } : {}) } };
}

export function koalaStopOf(raw: unknown): KoalaStop | undefined {
  if (!isObject(raw) || !nonEmpty(raw.installId)) return undefined;
  return { installId: raw.installId };
}

export function koalaInstallStoppedOf(raw: unknown): { ok: true; why: string } | { ok: false; problem: string } {
  if (!isObject(raw) || Object.keys(raw).some((key) => key !== 'why') || !nonEmpty(raw.why)) return { ok: false, problem: 'a stopped follow sends only "why", a non-empty string' };
  return { ok: true, why: raw.why };
}

export const PROVISION_PIECES = [
  { key: 'egress', title: 'The egress proxy' },
  { key: 'searxng', title: 'SearXNG, web search' },
  { key: 'crawl4ai', title: 'Crawl4AI, page reading' },
  { key: 'quickwit', title: 'Quickwit, the memory index\'s words' },
  { key: 'qdrant', title: 'Qdrant, the memory index\'s meanings' },
  { key: 'tei', title: 'TEI, the memory index\'s embeddings' },
  { key: 'gitea', title: 'Gitea, your repositories and images' },
  { key: 'verdaccio', title: 'The npm registry mirror' },
  { key: 'infisical', title: 'Infisical, your secrets' },
  { key: 'monitoring', title: 'Monitoring' },
] as const;

export type ProvisionPieceKey = (typeof PROVISION_PIECES)[number]['key'];

export const KOALA_PLATFORM_NAMESPACES = {
  egress: ['koala-egress'],
  searxng: ['searxng'],
  crawl4ai: ['crawl4ai'],
  quickwit: ['quickwit'],
  qdrant: ['qdrant'],
  tei: ['tei'],
  gitea: ['gitea', 'pipeline-builds'],
  verdaccio: ['koala-registry'],
  infisical: ['infisical'],
} as const satisfies Record<Exclude<ProvisionPieceKey, 'monitoring'>, readonly string[]>;

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
  | { kind: 'machine'; clusterId: string; machine: string; deviceId: string };

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
  root?: ProvisionRootRefusal;
}

export interface ProvisionRootRefusal {
  why: string;
  at: string;
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
