import { join } from 'node:path';
import type { Project } from './graph.js';

export interface Workspace { name: string; folder: string; tsconfig: string }

export const WORKSPACES: readonly Workspace[] = [
  { name: 'backend', folder: 'apps/backend', tsconfig: 'tsconfig.json' },
  { name: 'frontend', folder: 'apps/frontend', tsconfig: 'tsconfig.app.json' },
  { name: 'local-agent', folder: 'apps/local-agent', tsconfig: 'tsconfig.json' },
  { name: 'engine-core', folder: 'packages/engine-core', tsconfig: 'tsconfig.json' },
  { name: 'context-engine', folder: 'packages/context-engine', tsconfig: 'tsconfig.json' },
  { name: 'agent-engine', folder: 'packages/agent-engine', tsconfig: 'tsconfig.json' },
  { name: 'cdktf-infra', folder: 'packages/cdktf-infra', tsconfig: 'tsconfig.json' },
];

export const workspaceOf = (file: string): Workspace | undefined => WORKSPACES.find((workspace) => file.startsWith(`${workspace.folder}/`));

export const projectsOf = (root: string, workspaces: readonly Workspace[] = WORKSPACES): Project[] =>
  workspaces.map((workspace) => ({ tsconfig: join(root, workspace.folder, workspace.tsconfig), owns: (file) => workspaceOf(file) === workspace }));

export function areaOf(file: string): string {
  const parts = file.split('/');
  if (parts[0] === 'apps' && parts[1] === 'backend' && parts[2] === 'src') return parts.length > 4 ? `backend/${parts[3]}` : 'backend';
  if (parts[0] === 'apps' && parts[1] === 'frontend' && parts[2] === 'src') {
    if (parts[3] === 'features' && parts.length > 5) return `frontend/${parts[4]}`;
    return parts.length > 4 ? `frontend/${parts[3]}` : 'frontend';
  }
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 2).join('/');
  return parts[0] ?? file;
}
