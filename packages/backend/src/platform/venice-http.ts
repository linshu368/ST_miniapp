import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from 'undici';
import { config } from './config.js';

let proxyAgent: ProxyAgent | undefined;
let proxyAgentForUrl: string | undefined;

export type VeniceFetchInit = RequestInit & {
  /** Node fetch / undici streaming request body support. */
  duplex?: 'half';
};

/**
 * Venice API 出站入口。
 * - 未配置 VENICE_HTTPS_PROXY：直连（Railway/生产默认）
 * - 已配置：经 HTTP CONNECT 代理（本地开发）
 */
export async function veniceFetch(
  input: Parameters<typeof fetch>[0],
  init?: VeniceFetchInit
): Promise<Response> {
  const dispatcher = getVeniceProxyAgent();
  if (!dispatcher) {
    return fetch(input, init);
  }

  return undiciFetch(input as never, {
    ...(init as UndiciRequestInit),
    dispatcher,
  }) as unknown as Promise<Response>;
}

function getVeniceProxyAgent(): ProxyAgent | undefined {
  const proxyUrl = config.venice.httpsProxy;
  if (!proxyUrl) {
    proxyAgent = undefined;
    proxyAgentForUrl = undefined;
    return undefined;
  }

  if (proxyAgent && proxyAgentForUrl === proxyUrl) return proxyAgent;

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('venice_https_proxy_url_invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hash) {
    throw new Error('venice_https_proxy_url_invalid');
  }

  proxyAgent = new ProxyAgent(parsed.toString());
  proxyAgentForUrl = proxyUrl;
  return proxyAgent;
}
