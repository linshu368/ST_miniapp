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

const styleCatalog = [
  { id: 'style-dialogue', name: '对话偏好', description: '调整对话的展示偏好' },
  { id: 'style-tone', name: '语气偏好', description: '' },
];
const withStyleCatalog: GetGenerationConfigData = {
  ...cached,
  reply_style_options: styleCatalog,
};

describe('generation config optimistic cache updates', () => {
  it('applies only the requested optimistic field', () => {
    expect(mergeGenerationConfigPatch(cached, { pref_show_status: false })).toEqual({
      ...cached,
      config: { ...cached.config, pref_show_status: false },
    });
  });

  it('merges one style assignment into the existing preferences instead of replacing them', () => {
    const previous: GetGenerationConfigData = {
      ...withStyleCatalog,
      config: { ...cached.config, pref_reply_styles: { 'style-tone': true } },
    };
    expect(
      mergeGenerationConfigPatch(previous, { pref_reply_styles: { 'style-dialogue': true } })
    ).toEqual({
      ...previous,
      config: {
        ...previous.config,
        pref_reply_styles: { 'style-tone': true, 'style-dialogue': true },
      },
    });
  });

  it.each([true, false])('confirms an individual style assignment of %s', (enabled) => {
    const request = { pref_reply_styles: { 'style-dialogue': enabled } };
    const optimistic = mergeGenerationConfigPatch(withStyleCatalog, request);
    const response: PatchGenerationConfigData = {
      ...cached,
      config: { ...cached.config, pref_reply_styles: { 'style-dialogue': enabled } },
    };
    expect(mergeGenerationConfigResponse(optimistic, response, request)).toEqual({
      ...withStyleCatalog,
      config: response.config,
    });
  });

  it.each([
    ['first', 'second'],
    ['second', 'first'],
  ] as const)(
    'keeps both switches on when concurrent responses arrive %s then %s',
    (earlier, later) => {
      const requests = {
        first: { pref_reply_styles: { 'style-dialogue': true } },
        second: { pref_reply_styles: { 'style-tone': true } },
      };
      const responses: Record<'first' | 'second', PatchGenerationConfigData> = {
        first: {
          ...cached,
          config: {
            ...cached.config,
            pref_reply_styles: { 'style-dialogue': true, 'style-tone': false },
          },
        },
        second: {
          ...cached,
          config: {
            ...cached.config,
            pref_reply_styles: { 'style-dialogue': false, 'style-tone': true },
          },
        },
      };
      const first = mergeGenerationConfigPatch(withStyleCatalog, requests.first);
      const both = mergeGenerationConfigPatch(first, requests.second);
      const afterEarlier = mergeGenerationConfigResponse(
        both,
        responses[earlier],
        requests[earlier]
      );
      const confirmed = mergeGenerationConfigResponse(
        afterEarlier,
        responses[later],
        requests[later]
      );
      expect(confirmed.config.pref_reply_styles).toEqual({
        'style-dialogue': true,
        'style-tone': true,
      });
      expect(confirmed.reply_style_options).toEqual(styleCatalog);
    }
  );

  it.each([true, false])(
    'rolls back only the failed switch whether failure is first=%s',
    (failureFirst) => {
      const failedRequest = { pref_reply_styles: { 'style-dialogue': true } };
      const successfulRequest = { pref_reply_styles: { 'style-tone': true } };
      const first = mergeGenerationConfigPatch(withStyleCatalog, failedRequest);
      const both = mergeGenerationConfigPatch(first, successfulRequest);
      const response: PatchGenerationConfigData = {
        ...cached,
        config: { ...cached.config, pref_reply_styles: { 'style-tone': true } },
      };
      const fail = (value: GetGenerationConfigData) =>
        rollbackGenerationConfigPatch(value, failedRequest, cached.config);
      const succeed = (value: GetGenerationConfigData) =>
        mergeGenerationConfigResponse(value, response, successfulRequest);
      const current = failureFirst ? succeed(fail(both)) : fail(succeed(both));
      expect(current.config.pref_reply_styles).toEqual({ 'style-tone': true });
      expect(current.reply_style_options).toEqual(styleCatalog);
    }
  );

  it('restores an explicit false without rolling back other style or custom preferences', () => {
    const previous: GetGenerationConfigData = {
      ...withStyleCatalog,
      config: { ...cached.config, pref_reply_styles: { 'style-dialogue': false } },
    };
    const request = { pref_reply_styles: { 'style-dialogue': true } };
    const first = mergeGenerationConfigPatch(previous, request);
    const current = mergeGenerationConfigPatch(first, {
      pref_reply_styles: { 'style-tone': true },
      pref_custom_instructions: '保持克制',
      pref_show_status: false,
    });
    expect(rollbackGenerationConfigPatch(current, request, previous.config).config).toEqual({
      ...previous.config,
      pref_reply_styles: { 'style-dialogue': false, 'style-tone': true },
      pref_custom_instructions: '保持克制',
      pref_show_status: false,
    });
  });

  it('restores an absent legacy preference map after the only style save fails', () => {
    const request = { pref_reply_styles: { 'style-dialogue': true } };
    const current = mergeGenerationConfigPatch(cached, request);
    expect(rollbackGenerationConfigPatch(current, request, cached.config)).toEqual(cached);
  });

  it('keeps a later change of the same switch when its old response or failure arrives', () => {
    const older = { pref_reply_styles: { 'style-dialogue': true } };
    const first = mergeGenerationConfigPatch(cached, older);
    const current = mergeGenerationConfigPatch(first, {
      pref_reply_styles: { 'style-dialogue': false },
    });
    const response: PatchGenerationConfigData = {
      ...cached,
      config: { ...cached.config, pref_reply_styles: { 'style-dialogue': true } },
    };
    expect(mergeGenerationConfigResponse(current, response, older)).toEqual(current);
    expect(rollbackGenerationConfigPatch(current, older, cached.config)).toEqual(current);
  });

  it('preserves styles and their public catalog when an old length response omits both', () => {
    const length = { pref_word_count: '500-800' };
    const first = mergeGenerationConfigPatch(withStyleCatalog, length);
    const current = mergeGenerationConfigPatch(first, {
      pref_reply_styles: { 'style-dialogue': true },
    });
    const response: PatchGenerationConfigData = {
      ...cached,
      config: { ...cached.config, pref_word_count: '500-800' },
    };
    expect(mergeGenerationConfigResponse(current, response, length)).toEqual(current);
  });

  it('uses an explicitly empty published catalog instead of retaining old visible rows', () => {
    const request = { pref_reply_styles: { 'style-dialogue': true } };
    const current = mergeGenerationConfigPatch(withStyleCatalog, request);
    const response: PatchGenerationConfigData = {
      ...cached,
      config: current.config,
      reply_style_options: [],
    };
    expect(mergeGenerationConfigResponse(current, response, request).reply_style_options).toEqual(
      []
    );
  });

  it('confirms a nonoptimistic style save without replacing the other keys or public catalog', () => {
    const current: GetGenerationConfigData = {
      ...withStyleCatalog,
      config: { ...cached.config, pref_reply_styles: { 'style-tone': true } },
    };
    const request = { pref_reply_styles: { 'style-dialogue': true } };
    const response: PatchGenerationConfigData = {
      ...cached,
      config: { ...cached.config, pref_reply_styles: { 'style-dialogue': true } },
    };
    expect(mergeGenerationConfigResponse(current, response, request, false)).toEqual({
      ...current,
      config: {
        ...current.config,
        pref_reply_styles: { 'style-tone': true, 'style-dialogue': true },
      },
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
