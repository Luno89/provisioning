import type { ExtensionRuntime } from '../types.js';
import { createMonitoringTools, type MonitoringToolDeps } from './handlers.js';

export interface MonitoringRuntimeDeps {
  tools?: MonitoringToolDeps | undefined;
}

export const monitoringRuntime = (deps: MonitoringRuntimeDeps): ExtensionRuntime => ({
  operations: {},
  tools: deps.tools ? createMonitoringTools(deps.tools) : {},
});
