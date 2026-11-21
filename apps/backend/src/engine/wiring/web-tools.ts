import { dependencyFetch } from '@koala/engine-core/http';
import { publicAddressProblem, type DependencyReporter, type WebToolSettings } from '../../platform/index.js';
import { resolveWebTools, type WebToolsDeps } from '../lib/web-tools-resolver.js';
import type { WebTools } from '../lib/web-tools.js';

export interface WebToolsPlace {
  settings: WebToolSettings;
  dependencies?: DependencyReporter | undefined;
}

export const webToolsDeps = (place: WebToolsPlace): WebToolsDeps => ({
  settings: place.settings,
  pageCheck: publicAddressProblem,
  dependencies: place.dependencies,
  baseFetch: (input, init) => dependencyFetch(input, init),
});

export const buildWebTools = (place: WebToolsPlace): Promise<WebTools> => resolveWebTools(webToolsDeps(place));
