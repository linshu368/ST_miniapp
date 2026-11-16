import { observation } from '../../platform/observability/runtime.js';
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
    observation.emit(
      'conversation.styles_config_invalid',
      'conversation.config',
      {
        outcome: 'degraded',
        outcome_known: false,
        resource: REPLY_STYLE_OPTIONS_KEY,
        config_version: entry.version,
        err: parsed.error,
      },
      'warn'
    );
    return [];
  }

  return parsed.data.options
    .filter((option) => option.enabled)
    .map(({ id, name, description }) => ({ id, name, description }));
}
