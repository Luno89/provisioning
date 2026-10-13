import type { DeploymentMetadata } from './types.js';
import { projectApps } from './project-removal.js';
import type { ProjectMetadata } from './types.js';

export type ExposureMode = 'local' | 'public';

export interface AppAddresses {
  app?: string | undefined;
  preview?: string | undefined;
}

export interface ProjectApp {
  id: string;
  name: string;
  status: DeploymentMetadata['status'];
  local: AppAddresses;
  public: AppAddresses;
}

const present = (addresses: AppAddresses): AppAddresses => ({
  ...(addresses.app ? { app: addresses.app } : {}),
  ...(addresses.preview ? { preview: addresses.preview } : {}),
});

export function projectAppOf(project: Pick<ProjectMetadata, 'id' | 'name' | 'ownerId'>, deployments: readonly DeploymentMetadata[]): ProjectApp | undefined {
  const apps = projectApps(project, deployments.filter((deployment) => deployment.ownerId === project.ownerId));
  const app = apps.find((deployment) => deployment.status === 'running') ?? apps[0];
  if (!app) return undefined;
  return {
    id: app.id,
    name: app.name,
    status: app.status,
    local: present({ app: app.localExposureUrl, preview: app.previewLocalUrl }),
    public: present({ app: app.publicExposureUrl, preview: app.previewPublicUrl }),
  };
}
