import type { DeploymentMetadata, ProjectMetadata } from '../../platform/index.js';
import { projectAppOf, type ExposureMode, type ProjectApp } from '../lib/project-app.js';

export interface ProjectAppDeps {
  deployments: () => Promise<DeploymentMetadata[]>;
  expose: (deploymentId: string, mode: ExposureMode) => Promise<unknown>;
}

export type OpenRefusal = { status: 409; error: string };

export class ProjectAppService {
  constructor(private readonly deps: ProjectAppDeps) {}

  async app(project: Pick<ProjectMetadata, 'id' | 'name' | 'ownerId'>): Promise<ProjectApp | undefined> {
    return projectAppOf(project, await this.deps.deployments());
  }

  async open(project: Pick<ProjectMetadata, 'id' | 'name' | 'ownerId'>, mode: ExposureMode): Promise<ProjectApp | OpenRefusal> {
    const app = await this.app(project);
    if (!app) return { status: 409, error: 'the project has no app yet: it is made by the first build that deploys' };
    if (app.status !== 'running') return { status: 409, error: `the app is ${app.status}, not running, so there is nothing to open yet` };
    if (app[mode].app) return app;
    await this.deps.expose(app.id, mode);
    const exposed = await this.app(project);
    if (!exposed?.[mode].app) return { status: 409, error: 'the app was exposed but has no address' };
    return exposed;
  }
}
