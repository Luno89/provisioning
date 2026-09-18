import { fittedMaxTokens, type ModelProvider, type EngineEndpoint } from '@koala/agent-engine';
import type { AgentRegistry } from './registry.js';
import type { SamplingConfig } from '@koala/harness-types';

export interface ResolvedEndpoint {
  endpoint: EngineEndpoint;
  sampling?: SamplingConfig | undefined;
  maxTokens: number;
}

export type ResolvedAgentEndpoint = ResolvedEndpoint;

export interface ModelServiceLike {
  resolveBaseUrl(
    userId: string,
    modelId?: string | null,
    packEndpointId?: string | null,
  ): Promise<{ provider: ModelProvider; baseUrl: string; apiKey?: string }>;
}

export interface EndpointResolverOptions {
  models: ModelServiceLike;
  registry: AgentRegistry;
  defaultReplyTokens?: number | undefined;
}

export const DEFAULT_REPLY_TOKENS = 4096;

export class UnknownAgentError extends Error {
  constructor(slug: string) {
    super(`There is no agent called "${slug}".`);
    this.name = 'UnknownAgentError';
  }
}

export function createEndpointResolver(options: EndpointResolverOptions) {
  const ceiling = options.defaultReplyTokens ?? DEFAULT_REPLY_TOKENS;

  return {
    async forAgent(input: {
      ownerId: string;
      agentSlug: string;
      promptChars?: number;
      modelId?: string | undefined;
    }): Promise<ResolvedEndpoint> {
      const agent = await options.registry.agent(input.ownerId, input.agentSlug);
      if (!agent) throw new UnknownAgentError(input.agentSlug);

      const { provider, baseUrl, apiKey } = await options.models.resolveBaseUrl(
        input.ownerId,
        input.modelId,
        agent.model?.endpointId ?? undefined,
      );

      const endpoint: EngineEndpoint = {
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(provider.model ? { model: provider.model } : {}),
        ...(provider.kind ? { kind: provider.kind } : {}),
        rateLimitKey: provider.id,
        ownerId: input.ownerId,
        label: provider.name,
      };

      const budget = {
        contextTokens: provider.contextTokens ?? 32_000,
        contextMargin: 1_000,
        minReplyTokens: 512,
      };

      const maxTokens = fittedMaxTokens(
        budget as never,
        ceiling,
        input.promptChars ?? 0,
      );

      return {
        endpoint,
        ...(agent.sampling ? { sampling: agent.sampling } : {}),
        maxTokens,
      };
    },
  };
}

export type EndpointResolver = ReturnType<typeof createEndpointResolver>;
