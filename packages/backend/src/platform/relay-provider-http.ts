import { ProxyAgent } from 'undici';
import type { RelayProvider } from '@miniapp/shared';
import { getRelayProxyUrl } from './runtime-config.js';
import { observedFetch } from './observability/fetch.js';

const proxies = new Map<RelayProvider, { url: string; agent: ProxyAgent }>();

/** Provider-scoped opt-in CONNECT proxy. Redirects remain disabled before attaching credentials. */
export function relayProviderFetch(
  provider: RelayProvider,
  operation: string
): typeof globalThis.fetch {
  return (input, init) => {
    const proxy = getRelayProxyUrl(provider);
    let dispatcher: ProxyAgent | undefined;
    if (proxy) {
      let url: URL;
      try {
        url = new URL(proxy);
      } catch {
        throw new Error('relay_proxy_url_invalid');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.hash)
        throw new Error('relay_proxy_url_invalid');
      let cached = proxies.get(provider);
      if (!cached || cached.url !== proxy) {
        if (cached) void cached.agent.close().catch(() => undefined);
        cached = { url: proxy, agent: new ProxyAgent(proxy) };
        proxies.set(provider, cached);
      }
      dispatcher = cached.agent;
    }
    const options: RequestInit & { dispatcher?: ProxyAgent } = {
      ...init,
      redirect: 'error',
      ...(dispatcher ? { dispatcher } : {}),
    };
    return observedFetch(operation, input, options, { provider });
  };
}
