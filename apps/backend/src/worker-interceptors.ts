import { resolve } from 'node:path';
import { servesTenants, type RoleConfig } from './platform/index.js';

export function workflowInterceptorModules(role: RoleConfig): string[] {
  const modules = [resolve(import.meta.dirname, 'workflows/telemetry-interceptors.ts')];
  if (servesTenants(role)) modules.push(resolve(import.meta.dirname, 'workflows/failure-reports.ts'));
  return modules;
}
