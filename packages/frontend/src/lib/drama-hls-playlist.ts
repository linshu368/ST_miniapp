/**
 * 从 HLS 主清单里选出 hls.js 起播时最先请求的两份子清单：最低档视频和它的默认音轨。
 *
 * hls.js 1.7.4（level-controller）先按 RESOLUTION 高度、再按帧率等把档位从低到高排，
 * 配合 `startLevel: 0` 起播用的就是高度最低的一档；同高度时取码率更低的。音轨取该档
 * AUDIO 分组里 DEFAULT=YES 的一条，没有就取组内第一条。URL 用主清单地址解析相对路径，
 * 与 hls.js 的解析结果一致。格式不认识时返回空数组：只会预取不到，不会影响播放。
 */

type Attributes = Record<string, string>;

/** 属性列表按逗号分隔，但带引号的值里允许逗号（如 CODECS="avc1.640028,mp4a.40.2"）。 */
function parseAttributes(input: string): Attributes {
  const attrs: Attributes = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of input.matchAll(pattern)) {
    const [, key, raw] = match;
    attrs[key!] = raw!.startsWith('"') ? raw!.slice(1, -1) : raw!;
  }
  return attrs;
}

function resolve(uri: string | undefined, base: string): string | undefined {
  if (!uri) return undefined;
  try {
    return new URL(uri, base).href;
  } catch {
    return undefined;
  }
}

interface Variant {
  height: number;
  bandwidth: number;
  audio?: string;
  uri: string;
}

export function selectStartupPlaylists(manifest: string, manifestUrl: string): string[] {
  const lines = manifest.split(/\r?\n/).map((line) => line.trim());
  const variants: Variant[] = [];
  const audio: Array<Attributes> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO' && attrs.URI) audio.push(attrs);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      // 紧跟的第一条非注释行是该档位的地址。
      let next = i + 1;
      while (next < lines.length && (!lines[next] || lines[next]!.startsWith('#'))) next++;
      const uri = lines[next];
      if (!uri) continue;
      const height = Number(attrs.RESOLUTION?.split('x')[1]);
      variants.push({
        height: Number.isFinite(height) && height > 0 ? height : Number.POSITIVE_INFINITY,
        bandwidth: Number(attrs.BANDWIDTH) || Number.POSITIVE_INFINITY,
        audio: attrs.AUDIO,
        uri,
      });
      i = next;
    }
  }
  const lowest = variants.sort((a, b) => a.height - b.height || a.bandwidth - b.bandwidth)[0];
  if (!lowest) return [];
  const group = lowest.audio ? audio.filter((track) => track['GROUP-ID'] === lowest.audio) : [];
  const track = group.find((item) => item.DEFAULT === 'YES') ?? group[0];
  return [resolve(lowest.uri, manifestUrl), resolve(track?.URI, manifestUrl)].filter(
    (url): url is string => Boolean(url)
  );
}
