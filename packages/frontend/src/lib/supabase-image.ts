import { DEFAULT_TEST_SUPABASE_PROJECT_REF } from '@miniapp/shared/src/config/database';

export interface SupabaseImageOptions {
  width: number;
  height: number;
  quality?: number;
  resize?: 'cover' | 'contain' | 'fill';
}

const PUBLIC_OBJECT_PATH = '/storage/v1/object/public/';
const PUBLIC_RENDER_PATH = '/storage/v1/render/image/public/';

const TEST_STORAGE_ORIGIN = `https://${DEFAULT_TEST_SUPABASE_PROJECT_REF}.supabase.co`;
const TEST_PUBLIC_SAMPLES = new Set([
  'drama-covers/covers/065ff2e9-4eb7-5d6f-9b2f-d95ec98ff9c0/original.jpg',
  'character-assets/characters/platform_1691e6d7-cc11-4ceb-8718-db8a0bc583db.png',
]);

/** A string is ready to display; a URL can be used for responsive render variants. */
function resolvePublicImage(source: string): URL | string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return source;
  }
  const object = url.pathname.includes(PUBLIC_OBJECT_PATH);
  if (!object && !url.pathname.includes(PUBLIC_RENDER_PATH)) return source;
  if (process.env.ST_LIMIT_TEST_IMAGE_TRANSFORMS === 'true' && url.origin === TEST_STORAGE_ORIGIN) {
    const isRender = url.pathname.startsWith(PUBLIC_RENDER_PATH);
    const prefix = isRender ? PUBLIC_RENDER_PATH : PUBLIC_OBJECT_PATH;
    if (
      !url.pathname.startsWith(prefix) ||
      !TEST_PUBLIC_SAMPLES.has(url.pathname.slice(prefix.length))
    ) {
      if (!isRender) return source;
      // Older API responses may already contain a render URL. Also suppress srcset for these.
      url.pathname = url.pathname.replace(PUBLIC_RENDER_PATH, PUBLIC_OBJECT_PATH);
      for (const key of ['width', 'height', 'resize', 'quality', 'format'])
        url.searchParams.delete(key);
      return url.toString();
    }
  }
  if (object) url.pathname = url.pathname.replace(PUBLIC_OBJECT_PATH, PUBLIC_RENDER_PATH);
  return url;
}

function renderVariant(
  url: URL,
  { width, height, quality = 68, resize = 'cover' }: SupabaseImageOptions
): string {
  url.searchParams.set('width', String(width));
  url.searchParams.set('height', String(height));
  url.searchParams.set('resize', resize);
  url.searchParams.set('quality', String(quality));
  return url.toString();
}

export function supabasePublicImageUrl(source: string, options: SupabaseImageOptions): string {
  const image = resolvePublicImage(source);
  return typeof image === 'string' ? image : renderVariant(image, options);
}

/** 固定少量规格让浏览器选尺寸，同时避免制造过多 CDN cache key。 */
export function supabasePublicImageSrcSet(
  source: string,
  widths: readonly number[],
  ratio: { width: number; height: number },
  options: Pick<SupabaseImageOptions, 'quality' | 'resize'> = {}
): string | undefined {
  const image = resolvePublicImage(source);
  if (typeof image === 'string') return undefined;
  const candidates = widths.map((width) => {
    const transformed = renderVariant(image, {
      ...options,
      width,
      height: Math.round((width * ratio.height) / ratio.width),
    });
    return transformed === source ? null : `${transformed} ${width}w`;
  });
  return candidates.every((candidate) => candidate === null)
    ? undefined
    : candidates.filter((candidate): candidate is string => candidate !== null).join(', ');
}
