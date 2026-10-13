import { parsePipelineConfig, type PipelineConfig } from './pipeline-config.js';

export const PIPELINE_FILE = '.provisioning/pipeline.yml';

const SHA = /^[0-9a-f]{7,40}$/;

export const isCommitSha = (value: string): boolean => SHA.test(value);

export type BuildPlan =
  | { build: true; config: PipelineConfig | null; dockerfile: string; notes: string[] }
  | { build: false; reason: string };

export async function buildPlanAt(readFile: (path: string) => Promise<string | null>, commit: string): Promise<BuildPlan> {
  const notes: string[] = [];
  const pipelineFile = await readFile(PIPELINE_FILE);
  const pipeline = pipelineFile ? parsePipelineConfig(pipelineFile) : { config: null, error: null };
  if (pipelineFile && pipeline.error) notes.push(`${PIPELINE_FILE} ${pipeline.error} — building the repo root Dockerfile instead`);
  else if (pipelineFile) notes.push(`Found ${PIPELINE_FILE}: dockerfile=${pipeline.config?.dockerfile ?? 'Dockerfile'}, context=${pipeline.config?.context ?? '.'}, ${Object.keys(pipeline.config?.buildArgs ?? {}).length} build arg(s)`);
  else notes.push(`No ${PIPELINE_FILE} — building the repo root Dockerfile`);

  const dockerfile = pipeline.config?.dockerfile ?? 'Dockerfile';
  if (!(await readFile(dockerfile))) return { build: false, reason: `there is no Dockerfile at "${dockerfile}" in ${commit.slice(0, 8)}, so there is nothing to build into an image` };
  return { build: true, config: pipeline.config, dockerfile, notes };
}
