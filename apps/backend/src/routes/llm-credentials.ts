import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { v4 as uuidv4 } from 'uuid';
import { encryptValue } from '../lib/crypto.js';
import { buildIntelligenceIndex, intelligenceFor, type AaModel } from '../lib/intelligence-index.js';

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

interface GatewayPreset {
  label: string;
  baseUrl: string;
  docsUrl: string;
  modelListAuth: boolean; // true if model list endpoint needs the api key
  icon: string;
  color: string;
}

const GATEWAY_PRESETS: Record<string, GatewayPreset> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
    modelListAuth: false,
    icon: '◇',
    color: '#FF6600',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/keys',
    modelListAuth: false,
    icon: '⚡',
    color: '#F55036',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    docsUrl: 'https://api.together.ai/settings/api-keys',
    modelListAuth: false,
    icon: '◆',
    color: '#FF6B6B',
  },
  mistral: {
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://console.mistral.ai/api-keys/',
    modelListAuth: true,
    icon: '◈',
    color: '#FF9900',
  },
};

interface ModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  /** Per-token, as decimal strings — "0.00001" is $10 per million. */
  pricing?: { prompt?: string; completion?: string };
}

export interface ModelPricing {
  promptPerMTok: number;
  completionPerMTok: number;
}

/**
 * Per-token decimal string to dollars per million tokens.
 *
 * A gateway uses a negative price for "variable" or "auto-routed", which is not a number we can
 * show, so it reads the same as absent rather than as free.
 */
function perMillion(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return perToken * 1_000_000;
}

export function pricingOf(entry: ModelEntry): ModelPricing | undefined {
  const promptPerMTok = perMillion(entry.pricing?.prompt);
  const completionPerMTok = perMillion(entry.pricing?.completion);
  if (promptPerMTok === undefined || completionPerMTok === undefined) return undefined;
  return { promptPerMTok, completionPerMTok };
}

async function fetchModelList(
  baseUrl: string,
  apiKey: string | undefined,
  needsAuth: boolean,
): Promise<{
  models: { id: string; contextTokens?: number; label?: string; pricing?: ModelPricing }[];
  error?: string;
}> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (needsAuth) {
    if (!apiKey) return { models: [], error: 'API key is required for this provider' };
    headers.authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { models: [], error: `Provider returned ${res.status}: ${text.slice(0, 200)}` };
    }
    const body = await res.json() as { data?: ModelEntry[]; models?: ModelEntry[] };
    const data = body.data ?? body.models ?? [];
    const models = data.map((m: ModelEntry) => {
      const pricing = pricingOf(m);
      return {
        id: m.id,
        label: m.name ?? m.id,
        // Spread rather than assign undefined: `exactOptionalPropertyTypes` treats an explicit
        // undefined as a value, and the field is declared optional.
        // The window the gateway reports, not a capped copy of it. This was clamped to 200k,
        // which understated a million-token model fivefold — and `contextPressure` divides BY the
        // window, so the clamp made long-context models trim and hand off far earlier than they
        // needed to. `fittedMaxTokens` is bounded by the pack's ceiling either way.
        ...(m.context_length ? { contextTokens: m.context_length } : {}),
        ...(pricing ? { pricing } : {}),
      };
    });
    return { models };
  } catch (err: any) {
    return { models: [], error: err?.message ?? 'Failed to reach provider' };
  }
}


const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';

/**
 * Artificial Analysis' catalogue, keyed for lookup — or an empty index when the account has no key
 * for them or they are unreachable.
 *
 * Scores are a nice-to-have beside a model, never a reason a refresh fails: without this the one
 * unreachable third party would block backfilling pricing and context windows too.
 */
async function intelligenceIndex(
  credentials: any,
  userId: string,
): Promise<Map<string, number>> {
  try {
    const resolved = await credentials?.resolveCredentials?.(userId, 'artificialanalysis');
    const apiKey = resolved?.env?.ARTIFICIALANALYSIS_API_KEY ?? resolved?.values?.apiKey;
    if (!apiKey) return new Map();

    const res = await fetch(AA_MODELS_URL, {
      headers: { accept: 'application/json', 'x-api-key': String(apiKey) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return new Map();
    const body = await res.json() as { data?: AaModel[] };
    return buildIntelligenceIndex(body.data ?? []);
  } catch {
    return new Map();
  }
}

export function llmCredentialsRouter(deps: Record<string, any>): Router {
  const { db, jwtSecret, credentialService } = deps;
  const router = Router();

  router.get('/llm', asyncRoute(async (req, res) => {
    const endpoints = await db.getModelEndpoints();
    const userId = userOf(req).id;
    const userEndpoints = endpoints.filter((e: any) => e.ownerId === userId);
    const gateways = Object.entries(GATEWAY_PRESETS).map(([key, preset]) => {
      const models = userEndpoints.filter((e: any) =>
        e.name?.startsWith(`${preset.label} · `) || e.baseUrl === preset.baseUrl,
      );
      return { provider: key, ...preset, modelCount: models.length, hasKey: models.some((m: any) => m.apiKeyEnc) };
    });
    res.json({ providers: gateways });
  }));

  router.post('/llm', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const { provider, apiKey, baseUrl, model } = (req.body ?? {}) as Record<string, string | undefined>;

    if (!provider) return res.status(400).json({ error: 'provider is required' });
    const preset: GatewayPreset | undefined = GATEWAY_PRESETS[provider as keyof typeof GATEWAY_PRESETS];

    let effectiveBaseUrl: string;
    let isCustom = false;

    if (preset) {
      effectiveBaseUrl = preset.baseUrl;
    } else if (provider === 'custom') {
      if (!baseUrl) return res.status(400).json({ error: 'baseUrl is required for custom endpoints' });
      effectiveBaseUrl = String(baseUrl).replace(/\/$/, '');
      isCustom = true;
    } else {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    if (isCustom) {
      if (!model) return res.status(400).json({ error: 'model is required for custom endpoints' });
      const label = apiKey ? `Custom · ${model}` : model;
      const existing = (await db.getModelEndpoints()).filter((e: any) => e.ownerId === userId);
      const found = existing.find((e: any) => e.name === label && e.baseUrl === effectiveBaseUrl && e.model === model);
      if (!found) {
        await db.saveModelEndpoint({
          id: uuidv4(),
          ownerId: userId,
          name: label,
          baseUrl: effectiveBaseUrl,
          model,
          ...(apiKey ? { apiKeyEnc: encryptValue(String(apiKey), jwtSecret) } : {}),
          createdAt: new Date().toISOString(),
        });
      }
      const endpoints = await db.getModelEndpoints();
      return res.json({ endpoints: endpoints.filter((e: any) => e.ownerId === userId) });
    }

    /**
     * Reachable only when `preset` matched — the branches above either set `isCustom` and returned,
     * or 400'd on an unknown provider. `isCustom` is a boolean, so it carries that narrowing where
     * the compiler cannot follow it; this restates it as a check the compiler can.
     */
    if (!preset) return res.status(400).json({ error: `Unknown provider: ${provider}` });

    // Preset provider — fetch model list and create records
    const { models, error } = await fetchModelList(effectiveBaseUrl, apiKey, preset.modelListAuth);
    if (error) return res.status(400).json({ error });

    if (models.length === 0) return res.status(400).json({ error: 'No models returned from provider' });

    // Remove old endpoint records for this provider
    const all = await db.getModelEndpoints();
    for (const e of all) {
      if (e.ownerId === userId && e.baseUrl === effectiveBaseUrl) {
        await db.deleteModelEndpoint(e.id);
      }
    }

    // Create one record per model
    for (const m of models) {
      await db.saveModelEndpoint({
        id: uuidv4(),
        ownerId: userId,
        name: `${preset.label} · ${m.id}`,
        baseUrl: effectiveBaseUrl,
        model: m.id,
        ...(apiKey ? { apiKeyEnc: encryptValue(String(apiKey), jwtSecret) } : {}),
        ...(m.contextTokens ? { contextTokens: m.contextTokens } : {}),
        ...(m.pricing ? { pricing: m.pricing } : {}),
        createdAt: new Date().toISOString(),
      });
    }

    const fresh = await db.getModelEndpoints();
    res.json({ endpoints: fresh.filter((e: any) => e.ownerId === userId) });
  }));

  /**
   * Re-read a gateway's model list onto the rows already stored, without touching the key.
   *
   * Rows written before a field existed — pricing, context window — would otherwise only be
   * backfilled by deleting and re-adding the gateway, which means re-entering the key and
   * regenerating every row id, breaking any pack or account default that names one. These presets
   * publish their model list unauthenticated, so the refresh needs no credential at all.
   */
  router.post('/llm/:provider/refresh', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const { provider } = req.params;
    const preset: GatewayPreset | undefined = GATEWAY_PRESETS[provider as keyof typeof GATEWAY_PRESETS];
    if (!preset) return res.status(400).json({ error: `Unknown provider: ${provider}` });

    const mine = (await db.getModelEndpoints())
      .filter((e: any) => e.ownerId === userId && e.baseUrl === preset.baseUrl);
    if (mine.length === 0) {
      return res.status(404).json({ error: `${preset.label} is not set up on this account` });
    }

    const { models, error } = await fetchModelList(preset.baseUrl, undefined, preset.modelListAuth);
    if (error) return res.status(400).json({ error });

    const fresh = new Map(models.map((m) => [m.id, m]));
    const scores = await intelligenceIndex(credentialService, userId);

    let updated = 0;
    let scored = 0;
    for (const row of mine) {
      const match = row.model ? fresh.get(row.model) : undefined;
      if (!match) continue;
      const intelligence = row.model ? intelligenceFor(row.model, scores) : undefined;
      if (intelligence !== undefined) scored++;
      await db.saveModelEndpoint({
        ...row,
        ...(match.contextTokens ? { contextTokens: match.contextTokens } : {}),
        ...(match.pricing ? { pricing: match.pricing } : {}),
        ...(intelligence !== undefined ? { intelligence } : {}),
      });
      updated++;
    }

    res.json({
      updated,
      unmatched: mine.length - updated,
      total: mine.length,
      scored,
      scoresAvailable: scores.size,
    });
  }));

  router.delete('/llm/:provider', asyncRoute(async (req, res) => {
    const userId = userOf(req).id;
    const { provider } = req.params;
    const preset: GatewayPreset | undefined = GATEWAY_PRESETS[provider as keyof typeof GATEWAY_PRESETS];
    if (!preset && provider !== 'custom') {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    const baseUrl = preset ? preset.baseUrl : undefined;
    const all = await db.getModelEndpoints();
    let removed = 0;
    for (const e of all) {
      if (e.ownerId === userId && (preset ? e.baseUrl === baseUrl : provider === 'custom')) {
        await db.deleteModelEndpoint(e.id);
        removed++;
      }
    }
    res.json({ removed });
  }));

  return router;
}