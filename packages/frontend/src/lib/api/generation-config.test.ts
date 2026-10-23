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

  it('keeps concurrent module and custom preferences when the length response arrives', () => {
    const lengthRequest = { pref_word_count: '500-800' };
    const afterLengthChange = mergeGenerationConfigPatch(cached, lengthRequest);
    const afterModuleChanges = mergeGenerationConfigPatch(afterLengthChange, {
      pref_show_status: false,
      pref_show_memory: false,
    });
    const current = mergeGenerationConfigPatch(afterModuleChanges, {
      pref_custom_instructions: '保持克制，少用修辞',
    });
    // The length request started before the other preferences, so its response
    // still carries their old server values.
    const lengthResponse: PatchGenerationConfigData = {
      config: { ...cached.config, pref_word_count: '500-800' },
      word_count_tiers: cached.word_count_tiers,
    };

    expect(mergeGenerationConfigResponse(current, lengthResponse, lengthRequest).config).toEqual({
      ...cached.config,
      pref_word_count: '500-800',
      pref_show_status: false,
      pref_show_memory: false,
      pref_custom_instructions: '保持克制，少用修辞',
    });
  });

  it('rolls back only a failed length save after other preferences change', () => {
    const lengthRequest = { pref_word_count: '500-800' };
    const afterLengthChange = mergeGenerationConfigPatch(cached, lengthRequest);
    const current = mergeGenerationConfigPatch(afterLengthChange, {
      pref_show_options: false,
      pref_show_status: false,
      pref_custom_instructions: '多一些对话，少一些旁白',
    });

    expect(rollbackGenerationConfigPatch(current, lengthRequest, cached.config).config).toEqual({
      ...cached.config,
      pref_word_count: '300-500',
      pref_show_options: false,
      pref_show_status: false,
      pref_custom_instructions: '多一些对话，少一些旁白',
    });
  });
});
