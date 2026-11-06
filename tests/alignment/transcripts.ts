import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Said, saidOnLine, withoutRepeats } from './said.js';

export interface Transcript { file: string; session: string; agent?: string }

interface Read { size: number; said: Said[] }
interface Cache { version: number; files: Record<string, Read> }

export const SAID_VERSION = 2;

export const projectFolderName = (repoRoot: string): string => repoRoot.replace(/[^A-Za-z0-9]/g, '-');

export function transcriptsOf(projectsDir: string, repoRoot: string): Transcript[] {
  if (!existsSync(projectsDir)) throw new Error(`${projectsDir} does not exist, so there are no transcripts to search`);
  const prefix = projectFolderName(repoRoot);
  const folders = readdirSync(projectsDir).filter((name) => name === prefix || name.startsWith(`${prefix}-`)).map((name) => join(projectsDir, name));
  return folders.flatMap((folder) => readdirSync(folder, { withFileTypes: true }).flatMap((entry): Transcript[] => {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) return [{ file: join(folder, entry.name), session: basename(entry.name, '.jsonl') }];
    const agents = join(folder, entry.name, 'subagents');
    if (!entry.isDirectory() || !existsSync(agents)) return [];
    return readdirSync(agents).filter((name) => name.endsWith('.jsonl')).map((name) => ({ file: join(agents, name), session: entry.name, agent: basename(name, '.jsonl') }));
  }));
}

const readCache = (file: string): Record<string, Read> => {
  if (!existsSync(file)) return {};
  const cache = JSON.parse(readFileSync(file, 'utf8')) as Partial<Cache>;
  return cache.version === SAID_VERSION && cache.files ? cache.files : {};
};

const NEWLINE = 0x0a;

async function readFrom(transcript: Transcript, start: number): Promise<Read> {
  const said: Said[] = [];
  let consumed = start;
  let rest = Buffer.alloc(0);
  for await (const chunk of createReadStream(transcript.file, { start })) {
    let pending = Buffer.concat([rest, chunk as Buffer]);
    for (let end = pending.indexOf(NEWLINE); end >= 0; end = pending.indexOf(NEWLINE)) {
      said.push(...saidOnLine(pending.subarray(0, end).toString('utf8'), transcript.session, transcript.agent));
      consumed += end + 1;
      pending = pending.subarray(end + 1);
    }
    rest = pending;
  }
  return { size: consumed, said };
}

export async function everythingSaid(transcripts: readonly Transcript[], cacheFile: string): Promise<Said[]> {
  const cache = readCache(cacheFile);
  const fresh: Record<string, Read> = {};
  for (const transcript of transcripts) {
    const size = statSync(transcript.file).size;
    const known = cache[transcript.file];
    const usable = known && known.size <= size ? known : { size: 0, said: [] };
    const added = usable.size === size ? { size, said: [] } : await readFrom(transcript, usable.size);
    fresh[transcript.file] = { size: added.size, said: [...usable.said, ...added.said] };
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ version: SAID_VERSION, files: fresh } satisfies Cache), { mode: 0o600 });
  return withoutRepeats(Object.values(fresh).flatMap((read) => read.said).sort((a, b) => a.at.localeCompare(b.at)));
}
