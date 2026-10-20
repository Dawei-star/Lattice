import { aiApi } from '../../api/ai.ts';
import type { AiStreamOptions } from '../../api/ai.ts';
import type { AiProvider, AiProviderRequest } from './provider.ts';

export interface HttpAiProviderOptions {
  id?: string;
  stream?: typeof aiApi.streamChat;
}

/** Existing server SSE transport, kept behind the provider contract. */
export function createHttpAiProvider(options: HttpAiProviderOptions = {}): AiProvider {
  const stream = options.stream ?? aiApi.streamChat;
  return {
    id: options.id ?? 'http',
    supportsStreaming: true,
    stream: (request: AiProviderRequest, requestOptions?: AiStreamOptions) => stream(request, requestOptions),
  };
}
