import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { v4 as uuidv4 } from 'uuid';
import { encryptValue } from '../lib/crypto.js';

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
}

async function fetchModelList(
  baseUrl: string,
  apiKey: string | undefined,
  needsAuth: boolean,
): Promise<{ models: { id: string; contextTokens?: number; label?: string }[]; error?: string }> {
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
    const body = await res.json();
    const data = body.data ?? body.models ?? [];
    const models = data.map((m: ModelEntry) => ({
      id: m.id,
      label: m.name ?? m.id,
      contextTokens: m.context_length ? Math.min(m.context_length, 200_000) : undefined,
    }));
    return { models };
  } catch (err: any) {
    return { models: [], error: err?.message ?? 'Failed to reach provider' };
  }
}

export function llmCredentialsRouter(deps: Record<string, any>): Router {
  const { db, jwtSecret } = deps;
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
        createdAt: new Date().toISOString(),
      });
    }

    const fresh = await db.getModelEndpoints();
    res.json({ endpoints: fresh.filter((e: any) => e.ownerId === userId) });
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