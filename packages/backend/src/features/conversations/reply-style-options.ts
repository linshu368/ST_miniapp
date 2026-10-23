import { ReplyStyleOptionsConfigSchema, type PublicReplyStyleOption } from '@miniapp/shared';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';

export const REPLY_STYLE_OPTIONS_KEY = 'reply_style_options';

/** UI metadata only. Private markers and rules never enter this projection or generation. */
export async function fetchPublicReplyStyleOptions(): Promise<PublicReplyStyleOption[]> {
  const entry = await fetchRuntimeConfigEntry(REPLY_STYLE_OPTIONS_KEY, AbortSignal.timeout(5_000));
  if (!entry) return [];

  const parsed = ReplyStyleOptionsConfigSchema.safeParse(entry.value);
  if (!parsed.success) {
    // Validation issues can contain operator text; log only the config identity/version.
    console.warn(
      `[reply-style-options] ${REPLY_STYLE_OPTIONS_KEY} (version ${entry.version}) 非法；已隐藏回复风格目录`
    );
    return [];
  }

  return parsed.data.options
    .filter((option) => option.enabled)
    .map(({ id, name, description }) => ({ id, name, description }));
}
