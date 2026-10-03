import { catalogueFor, groupsFor, operationsOf, type EngineExtension, type GroupDefinition, type HostOperation, type NodeCatalogue } from '@koala/agent-engine/procedure';
import { PLATFORM } from './platform/manifest.js';
import { GROVE } from './grove/manifest.js';

export const INSTALLED_EXTENSIONS: readonly EngineExtension[] = [PLATFORM, GROVE];

export const HOST_OPERATIONS: readonly HostOperation[] = operationsOf(INSTALLED_EXTENSIONS);

export const platformCatalogue = (): NodeCatalogue => catalogueFor(INSTALLED_EXTENSIONS);

export const platformGroups = (): GroupDefinition[] => groupsFor(INSTALLED_EXTENSIONS);
