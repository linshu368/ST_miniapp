/** Reject credential-bearing URLs before attaching either class of bearer token. */
export function normalizeRelayBaseUrl(value: string, kind: 'inference' | 'management'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('relay_provider_url_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('relay_provider_url_invalid');
  const path = url.pathname.replace(/\/+$/, '');
  if (kind === 'management') {
    if (path !== '' && path !== '/api') throw new Error('relay_management_url_invalid');
    return url.origin;
  }
  if (path !== '' && path !== '/v1') throw new Error('relay_inference_url_invalid');
  return `${url.origin}/v1`;
}
