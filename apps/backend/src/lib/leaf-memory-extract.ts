import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';
import type { MemoryItem } from './memory-store.js';
import type { Decision } from './memory-decide.js';
import { extractLeafMemories, supersede } from './leaf-memory.js';
import { buildTrackedFilesScript, parseTrackedFiles } from './leaf-checkout.js';

export interface ExtractMemoriesDeps {
  db: Pick<Database, 'getMemories' | 'saveMemory'>;
  workspaces: { exec(leafId: string, script: string, timeoutMs?: number): Promise<{ stdout: string }> };
  admit: (item: MemoryItem) => Promise<Decision>;
}

export interface ExtractMemoriesParams {
  leaf: Pick<Leaf, 'id' | 'ownerId' | 'title' | 'projectId'>;
  summary: string;
  succeeded: boolean;
  missingArtifacts: string[];
  verifyOutput?: string | undefined;
}

export async function extractAndSaveLeafMemories(deps: ExtractMemoriesDeps, params: ExtractMemoriesParams): Promise<void> {
  try {
    const tracked = await deps.workspaces
      .exec(params.leaf.id, buildTrackedFilesScript({ filterNoise: true, limit: 60 }), 60_000)
      .then((r) => parseTrackedFiles(r.stdout))
      .catch(() => [] as string[]);

    const learned = extractLeafMemories({
      leaf: params.leaf,
      trackedFiles: tracked,
      summary: params.summary,
      succeeded: params.succeeded,
      missingArtifacts: params.missingArtifacts,
      ...(params.verifyOutput ? { verifyOutput: params.verifyOutput } : {}),
    });

    if (!learned.length) return;

    const { save, invalidate } = supersede(await deps.db.getMemories(params.leaf.ownerId), learned);
    for (const item of invalidate) await deps.db.saveMemory(item).catch(() => undefined);
    for (const item of save) await deps.admit(item);
  } catch (err) {
    console.warn(`[leaf-memory-extract] could not record what leaf ${params.leaf.id} learned: ${(err as Error).message}`);
  }
}
