/**
 * The catalogue of app types that serve an OpenAI-compatible API.
 *
 * This is the single source of truth for "which deployments are LLM endpoints, and where do they
 * listen". It exists because that knowledge had drifted into three places:
 *
 *   1. model-registry.ts's private ENGINES map
 *   2. AppService's OPENAI_API_BASE_URL ternary — whose fallback handed EVERY non-tabbyapi app
 *      vLLM's service suffix and port 8000, so adding a third engine would have silently pointed
 *      it at the wrong port
 *   3. the CDKTF constructs that actually create the Services
 *
 * (3) is the ground truth and cannot import from here, so the values below are transcribed from it
 * and pinned by tests. Anything else that needs to reach a model endpoint must read this list
 * rather than re-deriving it — a fourth copy is how the ternary bug happened in the first place.
 *
 * These are PLATFORM values, not user input: the user picks an app type and a name, and everything
 * else is derived. Endpoints the platform did not deploy are handled separately, either by the
 * per-deployment escape hatch below or by a registered ModelEndpoint.
 */
import { clusterUrl } from './cluster-dns.js';

export interface LlmAppSpec {
  /** DeploymentMetadata.appType this applies to. */
  readonly appType: string;
  readonly label: string;
  /** Service is `${namespace}-${serviceSuffix}` — see constructs/vllm.ts, constructs/tabbyapi.ts. */
  readonly serviceSuffix: string;
  readonly port: number;
  /** Path prefix the OpenAI-compatible routes live under. */
  readonly apiPath: string;
  /** Which DeploymentMetadata field records the served model id. */
  readonly modelField: 'vllmModel' | 'tabbyModel';
  /**
   * Which field records the context window the engine was started with.
   *
   * ── WHY THIS BELONGS IN THE CATALOGUE ──
   * The number was already stored — `tabbyMaxSeqLen: 131072` sits on the deployment record — and
   * the agent loop computed every budget against a hardcoded 32,768 instead. So a 131K model ran
   * with a quarter of its window: `fittedMaxTokens` handed a leaf 2,806 generation tokens when
   * 101,000 were free. Naming the field here rather than reading it in the loop keeps the engine
   * knowledge in the one place that already knows a vLLM from a TabbyAPI.
   */
  /** Optional: a custom `llmApi` deployment records no window, and absent is the honest answer. */
  readonly contextField?: 'vllmMaxModelLen' | 'tabbyMaxSeqLen';
}

export const LLM_APPS: readonly LlmAppSpec[] = [
  {
    appType: 'vllm',
    label: 'vLLM',
    serviceSuffix: 'vllm',
    port: 8000,
    apiPath: '/v1',
    modelField: 'vllmModel',
    contextField: 'vllmMaxModelLen',
  },
  {
    appType: 'tabbyapi',
    label: 'TabbyAPI',
    serviceSuffix: 'tabbyapi',
    port: 5000,
    apiPath: '/v1',
    modelField: 'tabbyModel',
    contextField: 'tabbyMaxSeqLen',
  },
];

const BY_APP_TYPE = new Map(LLM_APPS.map((spec) => [spec.appType, spec]));

export function llmAppSpec(appType: string | undefined): LlmAppSpec | undefined {
  return appType ? BY_APP_TYPE.get(appType) : undefined;
}

/**
 * Whether this app type serves an OpenAI-compatible API.
 *
 * Note openwebui and hermes are deliberately absent: they CONSUME a model API rather than serving
 * one, which is an easy pair to wire up backwards.
 */
export function isLlmApp(appType: string | undefined): boolean {
  return llmAppSpec(appType) !== undefined;
}

/**
 * The in-cluster URL for a deployed LLM app — resolvable only from inside that same cluster, which
 * is why AppService refuses to hand it to a consumer on a different one.
 */
export function inClusterBaseUrl(spec: LlmAppSpec, namespace: string): string {
  // The Service is named `<namespace>-<suffix>` for these apps, which is a fact about how they
  // deploy rather than a different address shape.
  return clusterUrl(
    { service: `${namespace}-${spec.serviceSuffix}`, namespace, port: spec.port },
    { path: spec.apiPath },
  );
}

/**
 * Per-deployment override, for endpoints the catalogue cannot know about — a `gitapp` the user
 * built themselves that happens to serve an OpenAI-compatible API, or an engine the platform does
 * not package yet.
 *
 * This is the one place user-supplied values enter the deployed-app path, so it is opt-in and
 * explicit rather than inferred. A catalogue entry always wins over it: for a known app type the
 * platform's own values are authoritative, and letting a stored field override them would
 * reintroduce exactly the drift this module exists to remove.
 */
export interface LlmApiTag {
  readonly port: number;
  readonly serviceSuffix?: string;
  readonly apiPath?: string;
  readonly model?: string;
}

export function specFromTag(tag: LlmApiTag, appType: string): LlmAppSpec | undefined {
  if (!Number.isInteger(tag.port) || tag.port < 1 || tag.port > 65535) return undefined;
  return {
    appType,
    label: 'Custom',
    serviceSuffix: tag.serviceSuffix || appType,
    port: tag.port,
    apiPath: tag.apiPath || '/v1',
    modelField: 'vllmModel',
  };
}
