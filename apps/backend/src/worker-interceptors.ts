import { resolve } from 'node:path';
import { roleFromEnv, servesTenants } from './platform/index.js';

export function workflowInterceptorModules(env: Readonly<Record<string, string | undefined>>): string[] {
  const modules = [resolve(import.meta.dirname, 'workflows/telemetry-interceptors.ts')];
  if (servesTenants(roleFromEnv(env))) modules.push(resolve(import.meta.dirname, 'workflows/failure-reports.ts'));
  return modules;
}
