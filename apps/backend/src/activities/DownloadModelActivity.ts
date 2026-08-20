/**
 * DownloadModelActivity — pre-populates the shared model cache on the host BEFORE the app's K8s
 * Deployment is created, instead of leaving the download to the pod's own startup script.
 *
 * Only wired up for clusters where this process shares a filesystem with the K8s node — see
 * TemporalBridge.deploy()'s `modelCacheHostPath` resolution and AppDeployWorkflow.ts. Currently
 * that's just the native-k3s system/management cluster (TabbyAPI is GPU-only, and k3d's nested
 * containerd can't do real GPU passthrough, so TabbyAPI never actually runs anywhere else). A
 * remote cloud cluster's nodes aren't reachable from here at all, so this step is skipped for
 * those and the pod's own in-container download logic (still present, unchanged) is the fallback.
 *
 * Downloads directly via HTTP (see lib/huggingface.ts) rather than shelling out to TabbyAPI's own
 * `main.py download` — that CLI catches every failure internally and always exits 0 (confirmed
 * live: it silently marked a cache directory "complete" that was never actually written, and the
 * server crashed on next boot looking for a config.json that didn't exist). A real thrown
 * exception here gets genuine Temporal retries and shows up as an actual failed activity instead
 * of a mysteriously empty model directory two layers away.
 */
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

// Moved to lib/activity-timeouts.ts — see that file for why (workflow files must never import a
// VALUE from an activity file, only `import type`).
export { downloadModelActivityMeta } from '../lib/activity-timeouts.js';

export async function DownloadModelActivity(args: DownloadModelArgs): Promise<DownloadModelResult> {
  const folderName = computeModelFolderName(args.modelRepo, args.revision);
  const modelDir = path.join(args.cacheHostPath, folderName);
  const completeMarker = `${modelDir}.complete`;
  const configPath = path.join(modelDir, 'config.json');

  // Same idempotency contract as the pod's own fallback script: a marker alone isn't proof of a
  // real download, config.json actually being present is.
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
