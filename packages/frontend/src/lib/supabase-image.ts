export interface SupabaseImageOptions {
  width: number;
  height: number;
  quality?: number;
  resize?: 'cover' | 'contain' | 'fill';
}

const PUBLIC_OBJECT_PATH = '/storage/v1/object/public/';
const PUBLIC_RENDER_PATH = '/storage/v1/render/image/public/';

/**
 * Supabase public Storage 图片直接走其边缘 transformation URL，避免经过 Next 图片代理。
 * 非 Supabase public URL 原样返回，上传端或外部 CDN 的地址不会被错误改写。
 */
export function supabasePublicImageUrl(
  source: string,
  { width, height, quality = 68, resize = 'cover' }: SupabaseImageOptions
): string {
  try {
    const url = new URL(source);
    if (url.pathname.includes(PUBLIC_OBJECT_PATH)) {
      url.pathname = url.pathname.replace(PUBLIC_OBJECT_PATH, PUBLIC_RENDER_PATH);
    } else if (!url.pathname.includes(PUBLIC_RENDER_PATH)) {
      return source;
    }
    url.searchParams.set('width', String(width));
    url.searchParams.set('height', String(height));
    url.searchParams.set('resize', resize);
    url.searchParams.set('quality', String(quality));
    return url.toString();
  } catch {
    return source;
  }
}

/** 固定少量规格让浏览器选尺寸，同时避免制造过多 CDN cache key。 */
export function supabasePublicImageSrcSet(
  source: string,
  widths: readonly number[],
  ratio: { width: number; height: number },
  options: Pick<SupabaseImageOptions, 'quality' | 'resize'> = {}
): string | undefined {
  const candidates = widths.map((width) => {
    const transformed = supabasePublicImageUrl(source, {
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
