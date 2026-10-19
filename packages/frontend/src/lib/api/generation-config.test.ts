import { describe, expect, it } from 'vitest';
import type { GetGenerationConfigData, PatchGenerationConfigData } from '@miniapp/shared';
import {
  mergeGenerationConfigPatch,
  mergeGenerationConfigResponse,
  rollbackGenerationConfigPatch,
} from './generation-config';

const cached: GetGenerationConfigData = {
  config: {
    selected_model_id: null,
    pref_word_count: '300-500',
    pref_show_options: true,
    pref_show_status: true,
    pref_show_memory: true,
    pref_custom_instructions: null,
  },
  word_count_tiers: {
    tiers: [{ id: '300-500', ui_label: '适中', sort_order: 0 }],
    default_tier_id: '300-500',
    layout: { columns: 3 },
  },
};

describe('generation config optimistic cache updates', () => {
  it('applies only the requested optimistic field', () => {
    expect(mergeGenerationConfigPatch(cached, { pref_show_status: false })).toEqual({
      ...cached,
      config: { ...cached.config, pref_show_status: false },
    });
  });

  it('does not roll back another slot that changed after this request started', () => {
    const afterStatusToggle = mergeGenerationConfigPatch(cached, { pref_show_status: false });
    const afterMemoryToggle = mergeGenerationConfigPatch(afterStatusToggle, {
      pref_show_memory: false,
    });

    expect(
      rollbackGenerationConfigPatch(afterMemoryToggle, { pref_show_status: false }, cached.config)
        .config
    ).toMatchObject({
      pref_show_status: true,
      pref_show_memory: false,
    });
  });

  it('does not let an earlier response overwrite a later optimistic slot', () => {
    const afterStatusToggle = mergeGenerationConfigPatch(cached, { pref_show_status: false });
    const current = mergeGenerationConfigPatch(afterStatusToggle, { pref_show_memory: false });
    const statusResponse: PatchGenerationConfigData = {
      config: { ...cached.config, pref_show_status: false },
      word_count_tiers: {
        ...cached.word_count_tiers,
        layout: { columns: 4 },
      },
    };

    expect(
      mergeGenerationConfigResponse(current, statusResponse, { pref_show_status: false })
    ).toMatchObject({
      config: {
        pref_show_status: false,
        pref_show_memory: false,
      },
      word_count_tiers: { layout: { columns: 4 } },
    });
  });
});
