import { isRecord, type JsonRecord } from '../../platform/lib/json-shapes.js';
import type { DeploymentMetadata } from '../../platform/index.js';

type Kind = 'text' | 'number' | 'flag' | 'texts';

const CONFIGURABLE: Readonly<Record<string, Kind>> = {
  storage: 'texts',
  webRepo: 'text', webTag: 'text', dbRepo: 'text', dbTag: 'text',
  vllmModel: 'text', vllmGpuCount: 'number', vllmGpuVendor: 'text', vllmCachePvc: 'text', vllmHfToken: 'text',
  vllmMaxModelLen: 'number', vllmGpuMemUtil: 'number', vllmExtraArgs: 'text', openWebuiTargetId: 'text', hermesTargetId: 'text',
  vllmToolCallingEnabled: 'flag', vllmToolCallParser: 'text', vllmServedModelName: 'text',
  vllmMaxNumSeqs: 'number', vllmDtype: 'text', vllmEnablePrefixCaching: 'flag',
  tabbyModel: 'text', tabbyRevision: 'text', tabbyGpuCount: 'number', tabbyHfToken: 'text', tabbyCachePvc: 'text',
  tabbyImageTag: 'text', tabbyCacheMode: 'text', tabbyMaxSeqLen: 'number', tabbyMaxBatchSize: 'number',
  tabbyReasoning: 'flag', tabbyToolFormat: 'text', tabbyInlineModelLoading: 'flag', tabbyDisableAuth: 'flag',
  tabbyMemoryLimit: 'text', tabbyShmSize: 'text', tabbyCpuLimit: 'text',
  tabbyExtraEnv: 'text',
  webuiEnableWebSearch: 'flag', webuiWebSearchEngine: 'text', webuiWebSearchApiKey: 'text',
};

const KIND_WORDS: Readonly<Record<Kind, string>> = {
  text: 'text',
  number: 'a number',
  flag: 'true or false',
  texts: 'an object of text values',
};

function isKind(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'text': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'flag': return typeof value === 'boolean';
    case 'texts': return isTexts(value);
  }
}

export const isTexts = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

export type DeploymentConfigPatch = Partial<Omit<DeploymentMetadata, 'appSettings'>>;

export interface DeploymentConfigRead {
  patch: DeploymentConfigPatch;
  appSettings?: JsonRecord;
}

function isConfigPatch(patch: Record<string, unknown>): patch is DeploymentConfigPatch {
  return Object.entries(patch).every(([key, value]) => {
    const kind = CONFIGURABLE[key];
    return kind !== undefined && isKind(value, kind);
  });
}

export function deploymentConfigPatch(body: unknown): DeploymentConfigRead | { problem: string } {
  const fields = isRecord(body) ? body : {};
  const picked: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(CONFIGURABLE)) {
    const value = fields[key];
    if (value === undefined) continue;
    if (!isKind(value, kind)) return { problem: `${key} must be ${KIND_WORDS[kind]}` };
    picked[key] = value;
  }
  const appSettings = fields.appSettings;
  if (appSettings !== undefined && !isRecord(appSettings)) return { problem: 'appSettings must be an object' };
  if (!isConfigPatch(picked)) return { problem: 'the settings could not be read' };
  return { patch: picked, ...(appSettings ? { appSettings } : {}) };
}
