export type ArtifactPlace = 'minio' | 'mongo';

export interface StoredArtifact {
  id: string;
  ownerId: string;
  runId: string;
  name: string;
  contentType: string;
  size: number;
  place: ArtifactPlace;
  createdAt: string;
  expiresAt: string;
}

export const ARTIFACT_BUCKET = 'koala-artifacts';
export const MAX_RUN_BYTES = 50 * 1024 * 1024;
export const KEEP_DAYS = 14;
export const CHUNK_BYTES = 255 * 1024;
export const E2E_RESULTS_DIR = 'e2e-results/artifacts';

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webm: 'video/webm',
  zip: 'application/zip',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
};

export const contentTypeOf = (name: string): string => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export const expiresFrom = (now: string, days = KEEP_DAYS): string => new Date(Date.parse(now) + days * 86_400_000).toISOString();

export const objectKey = (artifact: Pick<StoredArtifact, 'runId' | 'id' | 'name'>): string =>
  `${artifact.runId}/${artifact.id}-${artifact.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

export function failureArtifacts(paths: readonly string[]): string[] {
  return paths
    .filter((path) => path.startsWith(`${E2E_RESULTS_DIR}/`))
    .filter((path) => /\.(png|jpe?g|webm|zip)$/i.test(path))
    .sort();
}

export function withinBudget<T extends { size: number }>(files: readonly T[], used: number, budget = MAX_RUN_BYTES): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  let total = used;
  for (const file of [...files].sort((a, b) => a.size - b.size)) {
    if (total + file.size <= budget) {
      kept.push(file);
      total += file.size;
    } else dropped.push(file);
  }
  return { kept, dropped };
}

export const chunksOf = (bytes: Buffer, size = CHUNK_BYTES): Buffer[] => {
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  return chunks.length > 0 ? chunks : [Buffer.alloc(0)];
};

export interface MinioCandidate {
  id: string;
  name: string;
  appType?: string | undefined;
  status: string;
  clusterId: string;
  ownerId?: string | undefined;
  minioRootUser?: string | undefined;
  minioRootPassword?: string | undefined;
}

export function minioOf<T extends MinioCandidate>(deployments: readonly T[], ownerId: string): T | undefined {
  return deployments.find((entry) => entry.appType === 'minio'
    && entry.status === 'running'
    && entry.ownerId === ownerId
    && Boolean(entry.minioRootPassword));
}

export interface ServiceSpec {
  spec?: { ports?: { name?: string; port: number; nodePort?: number }[] };
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
}

export function s3Address(service: ServiceSpec, nodeIp: string | undefined): { host: string; port: number } | undefined {
  const port = service.spec?.ports?.find((entry) => entry.name === 's3') ?? service.spec?.ports?.find((entry) => entry.port === 9000);
  if (!port) return undefined;
  if (nodeIp && port.nodePort) return { host: nodeIp, port: port.nodePort };
  const ingress = service.status?.loadBalancer?.ingress?.[0];
  const host = ingress?.ip ?? ingress?.hostname;
  return host ? { host, port: port.port } : undefined;
}

export interface WorkspaceExec {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export const listFailureArtifactsCommand = `find ${E2E_RESULTS_DIR} -type f -printf '%s %p\\n' 2>/dev/null`;

export function listedFiles(stdout: string): { path: string; size: number }[] {
  return stdout.split('\n').flatMap((line) => {
    const match = /^(\d+) (.+)$/.exec(line.trim());
    return match ? [{ size: Number(match[1]), path: match[2]! }] : [];
  });
}

export const artifactName = (path: string): string => path.slice(`${E2E_RESULTS_DIR}/`.length);

export const READ_PIECE_BYTES = 22_000;

export const readPieceCommand = (path: string, offset: number, bytes = READ_PIECE_BYTES): string =>
  `tail -c +${offset + 1} '${path.replace(/'/g, `'\\''`)}' | head -c ${bytes} | base64 -w0`;

async function readWhole(workspace: WorkspaceExec, path: string, size: number): Promise<Buffer | undefined> {
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < size; offset += READ_PIECE_BYTES) {
    const read = await workspace.exec(readPieceCommand(path, offset));
    if (read.exitCode !== 0) return undefined;
    pieces.push(Buffer.from(read.stdout.trim(), 'base64'));
  }
  const whole = Buffer.concat(pieces);
  return whole.length === size ? whole : undefined;
}

export async function readFailureArtifacts(workspace: WorkspaceExec, budget = MAX_RUN_BYTES): Promise<{ files: { name: string; bytes: Buffer }[]; dropped: string[]; unreadable: string[] }> {
  const listed = listedFiles((await workspace.exec(listFailureArtifactsCommand)).stdout);
  const wanted = new Set(failureArtifacts(listed.map((file) => file.path)));
  const { kept, dropped } = withinBudget(listed.filter((file) => wanted.has(file.path)), 0, budget);
  const files: { name: string; bytes: Buffer }[] = [];
  const unreadable: string[] = [];
  for (const file of kept) {
    const bytes = await readWhole(workspace, file.path, file.size);
    if (bytes) files.push({ name: artifactName(file.path), bytes });
    else unreadable.push(artifactName(file.path));
  }
  return { files, dropped: dropped.map((file) => artifactName(file.path)), unreadable };
}

export function artifactLines(stored: readonly Pick<StoredArtifact, 'id' | 'name'>[], dropped: readonly string[], unreadable: readonly string[] = []): string {
  if (stored.length === 0 && dropped.length === 0 && unreadable.length === 0) return '';
  return [
    'what the browser left behind:',
    ...stored.map((artifact) => (/\.(png|jpe?g)$/i.test(artifact.name)
      ? `- ${artifact.name}:\n\n  ![${artifact.name}](/api/artifacts/${artifact.id})`
      : `- [${artifact.name}](/api/artifacts/${artifact.id})`)),
    ...(dropped.length > 0 ? [`- not kept, over the run's ${MAX_RUN_BYTES / 1024 / 1024} MB: ${dropped.join(', ')}`] : []),
    ...(unreadable.length > 0 ? [`- not kept, they could not be read back whole: ${unreadable.join(', ')}`] : []),
  ].join('\n');
}

export type KeepArtifacts = (ownerId: string, runId: string, files: { name: string; bytes: Buffer }[]) => Promise<{ stored: { id: string; name: string }[]; dropped: string[]; minioMissing: boolean }>;

export async function keepFailureArtifacts(workspace: WorkspaceExec, keep: KeepArtifacts, ownerId: string, runId: string): Promise<{ lines: string; stored: { id: string; name: string }[] }> {
  try {
    const { files, dropped, unreadable } = await readFailureArtifacts(workspace);
    if (files.length === 0 && dropped.length === 0 && unreadable.length === 0) return { lines: '', stored: [] };
    const kept = files.length > 0 ? await keep(ownerId, runId, files) : { stored: [], dropped: [] };
    return { lines: artifactLines(kept.stored, [...dropped, ...kept.dropped], unreadable), stored: kept.stored };
  } catch (err) {
    return { lines: `what the browser left behind could not be kept: ${(err as Error).message}`, stored: [] };
  }
}
