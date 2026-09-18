export type ModelKind = 'vllm' | 'tabbyapi';

export type ModelSource = 'deployment' | 'endpoint';

export interface ModelProvider {
  id: string;
  name: string;
  source: ModelSource;
  kind?: ModelKind | undefined;
  model: string;
  /** Human label for where the model came from — vLLM, TabbyAPI, OpenRouter, etc. */
  sourceLabel?: string | undefined;

  clusterId?: string | undefined;
  namespace?: string | undefined;
  service?: string | undefined;
  port?: number | undefined;
  gpuCount?: number | undefined;
  contextTokens?: number | undefined;

  baseUrl?: string | undefined;
  isMesh?: boolean | undefined;
  hasApiKey?: boolean | undefined;
  /** Dollars per million tokens. Absent for a deployment — you pay for the box, not the token. */
  pricing?: { promptPerMTok: number; completionPerMTok: number } | undefined;
  /** Artificial Analysis Intelligence Index, when their catalogue matched this model. */
  intelligence?: number | undefined;
}
