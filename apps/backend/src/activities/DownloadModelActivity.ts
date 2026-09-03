import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getHfModelFiles, downloadHfFiles, type DownloadProgress } from '../lib/huggingface.js';
import { computeModelFolderName } from '../lib/model-folder-name.js';

export interface DownloadModelArgs {
  modelRepo: string;
  revision?: string | undefined;
  hfToken?: string | undefined;
  cacheHostPath: string;
  logFile?: string | undefined;
}

export interface DownloadModelResult {
  skipped: boolean;
  totalBytes: number;
  modelDir: string;
}

export { downloadModelActivityMeta } from '../lib/activity-timeouts.js';

const gib = (bytes: number) => (bytes / 1e9).toFixed(1);

async function log(logFile: string | undefined, line: string): Promise<void> {
  if (!logFile) return;
  await fsp.appendFile(logFile, `${line}\n`).catch(() => { /* best-effort — never fail the download over a log write */ });
}

export async function DownloadModelActivity(args: DownloadModelArgs): Promise<DownloadModelResult> {
  const folderName = computeModelFolderName(args.modelRepo, args.revision);
  const modelDir = path.join(args.cacheHostPath, folderName);
  const completeMarker = `${modelDir}.complete`;
  const configPath = path.join(modelDir, 'config.json');

  if (fs.existsSync(completeMarker) && fs.existsSync(configPath)) {
    await log(args.logFile, `[model-download] ${args.modelRepo}${args.revision ? `@${args.revision}` : ''} already cached — skipping download.`);
    return { skipped: true, totalBytes: 0, modelDir };
  }

  await fsp.rm(modelDir, { recursive: true, force: true });
  await fsp.mkdir(modelDir, { recursive: true });

  await log(args.logFile, `[model-download] Fetching file list for ${args.modelRepo}${args.revision ? `@${args.revision}` : ''}...`);
  const files = await getHfModelFiles(args.modelRepo, args.revision, args.hfToken);
  if (files.length === 0) {
    throw new Error(`No files found for ${args.modelRepo}@${args.revision || 'main'} — check the model name/revision.`);
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  await log(args.logFile, `[model-download] ${files.length} files, ${gib(totalBytes)} GB total. Downloading to ${modelDir}...`);

  const onProgress = (p: DownloadProgress) => {
    const pct = p.totalBytes > 0 ? Math.floor((p.downloadedBytes / p.totalBytes) * 100) : 0;
    void log(args.logFile, `[model-download] ${gib(p.downloadedBytes)} / ${gib(p.totalBytes)} GB (${pct}%)${p.currentFile ? ` — ${p.currentFile}` : ''}`);
  };
  await downloadHfFiles(files, modelDir, args.hfToken, onProgress);

  if (!fs.existsSync(configPath)) {
    await log(args.logFile, `[model-download] FAILED — ${configPath} is missing after download.`);
    throw new Error(
      `Downloaded ${args.modelRepo}@${args.revision || 'main'} but ${configPath} is missing — ` +
      `the download didn't fully complete or this repo doesn't have the expected layout.`,
    );
  }

  await fsp.writeFile(completeMarker, '');
  await log(args.logFile, `[model-download] Complete — ${gib(totalBytes)} GB.`);

  return { skipped: false, totalBytes, modelDir };
}
