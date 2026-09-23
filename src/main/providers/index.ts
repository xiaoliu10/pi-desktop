import type { ChatProvider, ChatRequest } from './base';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openai';
import type { ProviderConfig } from '../../shared/types';

export * from './base';

export function createProvider(provider: ProviderConfig, apiKey: string | null): ChatProvider {
  switch (provider.type) {
    case 'openai-compatible':
      return new OpenAICompatibleProvider({ baseUrl: provider.baseUrl, apiKey });
    case 'anthropic':
      return new AnthropicProvider({ baseUrl: provider.baseUrl, apiKey });
    default:
      throw new Error(`Unsupported provider type: ${(provider as ProviderConfig).type}`);
  }
}

/** Convenience for smoke tests: a trivial request shape. */
export function emptyRequest(model: string): ChatRequest {
  return { model, messages: [], tools: [] };
}
