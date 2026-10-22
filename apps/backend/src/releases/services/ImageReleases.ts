import type { PipelineRunMetadata, ProjectMetadata } from '../../platform/index.js';
import type { ReleaseDecision } from '../lib/release-paths.js';
import { REPLACE_AGENT, replaceRunId, type ReplaceRunInput } from '../lib/release-run.js';
import type { StartRunRequest } from '../../engine-host/registries/run-starter.js';

export interface ImageReleaseDeps {
  runs: { start(request: StartRunRequest): Promise<unknown> };
  deployedTag: (project: ProjectMetadata) => Promise<string | undefined>;
  decide?: ((project: ProjectMetadata, since: string, commit: string) => Promise<ReleaseDecision>) | undefined;
  ensureSecrets?: ((project: ProjectMetadata) => Promise<{ waiting: string[] }>) | undefined;
  noteOnBuild: (run: Partial<PipelineRunMetadata> & { id: string }) => Promise<unknown>;
  stamp?: (() => string) | undefined;
}

export type ImageReleaseOutcome = 'started' | 'not-auto-deployed' | { skipped: string } | { refused: string };

export class ImageReleases {
  constructor(private readonly deps: ImageReleaseDeps) {}

  async release(project: ProjectMetadata, run: PipelineRunMetadata, agent: string = REPLACE_AGENT): Promise<ImageReleaseOutcome> {
    if (!project.autoDeployOnBuild) return 'not-auto-deployed';
    if (!project.ownerId) return this.refuse(run, 'the project has no owner');
    const since = await this.deps.deployedTag(project);
    if (since && this.deps.decide) {
      const decision = await this.deps.decide(project, since, run.commitSha);
      if (!decision.release) {
        await this.deps.noteOnBuild({ id: run.id, releaseSkipped: decision.reason });
        return { skipped: decision.reason };
      }
    }
    const secrets = await this.deps.ensureSecrets?.(project);
    if (secrets?.waiting.length) return this.refuse(run, `waiting for the person to enter ${secrets.waiting.join(', ')}`);
    const inputs: ReplaceRunInput = { ownerId: project.ownerId, projectId: project.id, pipelineRunId: run.id };
    await this.deps.runs.start({
      ownerId: project.ownerId,
      agentSlug: agent,
      message: 'Deploy the build.',
      runId: replaceRunId(project.id, run.id, (this.deps.stamp ?? (() => Date.now().toString(36)))()),
      inputs: inputs as unknown as Record<string, unknown>,
      bound: { projectId: project.id },
    });
    return 'started';
  }

  private async refuse(run: PipelineRunMetadata, error: string): Promise<{ refused: string }> {
    await this.deps.noteOnBuild({ id: run.id, releaseRefused: error });
    return { refused: error };
  }
}
