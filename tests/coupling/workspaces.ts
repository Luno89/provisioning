import { join } from 'node:path';
import type { CrossProcess, Project } from './graph.js';
import { chartEnv, envChannels } from './env-edges.js';
import { httpChannels, httpMatches } from './http-routes.js';
import { shellEnds, shellScripts } from './shell-edges.js';
import { socketChannels } from './socket-edges.js';
import { temporalWorld } from './temporal-edges.js';

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

const temporalCalls = (root: string): NonNullable<Project['crossing']> => (program) => {
  const world = temporalWorld(program, join(root, 'apps/backend/src'));
  return (call): CrossProcess | undefined => {
    const proxied = world.proxied(call);
    if (proxied) return { to: world.implementations(proxied), through: 'temporal', ...(proxied.device ? { device: true } : {}) };
    const started = world.started(call);
    return started ? { to: started, through: 'temporal' } : undefined;
  };
};

const bothChannels: NonNullable<Project['channels']> = (program) => {
  const sockets = socketChannels(program);
  const http = httpChannels(program);
  return (call) => [...(sockets(call) ?? []), ...(http(call) ?? [])];
};

export const MATCHES = { http: httpMatches };

export const projectsOf = (root: string, workspaces: readonly Workspace[] = WORKSPACES): Project[] =>
  workspaces.map((workspace) => ({
    tsconfig: join(root, workspace.folder, workspace.tsconfig),
    owns: (file) => workspaceOf(file) === workspace,
    channels: bothChannels,
    ...(workspace.name === 'backend' ? { crossing: temporalCalls(root), readers: envChannels } : {}),
  }));

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

export const scriptEnds = (root: string) => shellScripts(root, 'scripts').flatMap((file) => shellEnds(root, file));

export const outsideEnds = (root: string) => [...scriptEnds(root), ...chartEnv(root)];
