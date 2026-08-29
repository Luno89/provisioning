import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getHfModelFiles, downloadHfFiles } from '../lib/huggingface.js';
import { computeModelFolderName } from '../lib/model-folder-name.js';

export interface DownloadModelArgs {
  modelRepo: string;
  revision?: string | undefined;
  hfToken?: string | undefined;
  cacheHostPath: string;
}

export interface DownloadModelResult {
  skipped: boolean;
  totalBytes: number;
  modelDir: string;
}

export { downloadModelActivityMeta } from '../lib/activity-timeouts.js';

export async function DownloadModelActivity(args: DownloadModelArgs): Promise<DownloadModelResult> {
  const folderName = computeModelFolderName(args.modelRepo, args.revision);
  const modelDir = path.join(args.cacheHostPath, folderName);
  const completeMarker = `${modelDir}.complete`;
  const configPath = path.join(modelDir, 'config.json');

  if (fs.existsSync(completeMarker) && fs.existsSync(configPath)) {
    return { skipped: true, totalBytes: 0, modelDir };
  }

  await fsp.rm(modelDir, { recursive: true, force: true });
  await fsp.mkdir(modelDir, { recursive: true });

  const files = await getHfModelFiles(args.modelRepo, args.revision, args.hfToken);
  if (files.length === 0) {
    throw new Error(`No files found for ${args.modelRepo}@${args.revision || 'main'} — check the model name/revision.`);
  }

  await downloadHfFiles(files, modelDir, args.hfToken);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Downloaded ${args.modelRepo}@${args.revision || 'main'} but ${configPath} is missing — ` +
      `the download didn't fully complete or this repo doesn't have the expected layout.`,
    );
  }

  await fsp.writeFile(completeMarker, '');

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return { skipped: false, totalBytes, modelDir };
}
