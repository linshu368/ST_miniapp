/** Only a Cloudflare Stream customer host is accepted; returns the origin, never the path. */
export function parseDramaStreamOrigin(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' &&
      /^customer-[a-z0-9-]+\.cloudflarestream\.com$/i.test(url.hostname)
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export const DRAMA_STREAM_ORIGIN = parseDramaStreamOrigin(
  process.env.NEXT_PUBLIC_DRAMA_STREAM_ORIGIN
);

// hls.js 用 CORS 请求，iOS 原生 <video> 不带 crossorigin，两者不共用连接池，各需一条。
export const DRAMA_STREAM_PRECONNECT_MODES = ['anonymous', undefined] as const;

/**
 * 页面加载时建好的空闲连接约 10s 就会被浏览器关闭；播放意图到设置源之间约 0.4s，
 * 足够完成 DNS 与 TLS。重新插入元素才会再次触发预连接。
 */
export function warmDramaStreamOrigin(): void {
  if (!DRAMA_STREAM_ORIGIN || typeof document === 'undefined') return;
  try {
    for (const node of document.head.querySelectorAll('link[data-drama-stream-warm]'))
      node.remove();
    for (const mode of DRAMA_STREAM_PRECONNECT_MODES) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = DRAMA_STREAM_ORIGIN;
      if (mode) link.crossOrigin = mode;
      link.dataset.dramaStreamWarm = '';
      document.head.appendChild(link);
    }
  } catch {
    // 建连提示失败不能影响取址。
  }
}
