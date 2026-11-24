import { RelayProviderConfigEditor } from './RelayProviderConfigEditor';
import { ReplyStyleOptionsEditor } from './ReplyStyleOptionsEditor';
import { DriveModeOptionsEditor } from './DriveModeOptionsEditor';
import { dedicatedConfigEditor } from './dedicatedConfigEditors';
import { LlmPricingConfigEditor } from './LlmPricingConfigEditor';

import { Alert, InputNumber } from 'antd';
import {
  CREATOR_REVIEW_PROMPT_KEY,
  DRIVE_MODE_OPTIONS_KEY,
  FREE_ZONE_CONFIG_KEY,
  IMAGE_PLAZA_DEFAULT_TAG_GROUP_ID,
  IMAGE_PLAZA_DEFAULT_TAG_GROUP_LABEL,
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaTagConfigSchema,
  VideoPlazaModelCatalogSchema,
  type InstructionSlotRules,
} from '@miniapp/shared';
import {
  configMetadata,
  EditableReplyStyleOptionsConfigSchema,
  EditableImagePlazaTagConfigSchema,
  normalizeVideoPlazaCatalogOptions,
} from '@miniapp/admin-client';

import {
  ImagePlazaModelCatalogEditor,
  ImagePlazaShareTipEditor,
  ImagePlazaTagsEditor,
  VideoPlazaModelCatalogEditor,
} from './ImagePlazaConfigEditors';
import { LobbyRankingParamsEditor } from './LobbyRankingParamsEditor';

import { FreeZoneConfigEditor } from './FreeZoneConfigEditor';

import { SystemInstructionsEditor } from './SystemInstructionsEditor';
import { CreatorReviewPromptEditor } from './CreatorReviewPromptEditor';
import { PlatformInstructionSlotRulesEditor } from './PlatformInstructionSlotRulesEditor';
import { WordCountTiersEditor } from './WordCountTiersEditor';

import type { ConfigValueEditorProps } from './config-value-types';
import { asWordCountTiersConfig } from './config-value-helpers';

export function renderConfigGroup1(props: ConfigValueEditorProps) {
  const result1 = renderBranch1(props);
  if (result1 !== null) return result1;
  const result2 = renderBranch2(props);
  if (result2 !== null) return result2;
  const result3 = renderBranch3(props);
  if (result3 !== null) return result3;
  const result4 = renderBranch4(props);
  if (result4 !== null) return result4;
  const result5 = renderBranch5(props);
  if (result5 !== null) return result5;
  const result6 = renderBranch6(props);
  if (result6 !== null) return result6;
  const result7 = renderBranch7(props);
  if (result7 !== null) return result7;
  const result8 = renderBranch8(props);
  if (result8 !== null) return result8;
  const result9 = renderBranch9(props);
  if (result9 !== null) return result9;
  const result10 = renderBranch10(props);
  if (result10 !== null) return result10;
  const result11 = renderBranch11(props);
  if (result11 !== null) return result11;
  const result12 = renderBranch12(props);
  if (result12 !== null) return result12;
  const result13 = renderBranch13(props);
  if (result13 !== null) return result13;
  const result14 = renderBranch14(props);
  if (result14 !== null) return result14;
  const result15 = renderBranch15(props);
  if (result15 !== null) return result15;
  const result16 = renderBranch16(props);
  if (result16 !== null) return result16;
  return null;
}

function renderBranch1(props: ConfigValueEditorProps) {
  if (props.configKey === 'llm_relay_provider_config')
    return (
      <RelayProviderConfigEditor
        value={props.value}
        onChange={props.onChange}
        disabled={props.disabled}
      />
    );
  return null;
}

function renderBranch2(props: ConfigValueEditorProps) {
  if (props.configKey === 'image_plaza_model_catalog') {
    const parsed = ImagePlazaModelCatalogSchema.safeParse(props.value);
    const fallback = ImagePlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_model_catalog.defaultValue
    );
    return (
      <ImagePlazaModelCatalogEditor
        value={parsed.success ? parsed.data : fallback}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch3(props: ConfigValueEditorProps) {
  if (props.configKey === 'image_plaza_video_model_catalog') {
    const parsed = VideoPlazaModelCatalogSchema.safeParse(props.value);
    const fallback = VideoPlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_video_model_catalog.defaultValue
    );
    const value = normalizeVideoPlazaCatalogOptions(parsed.success ? parsed.data : fallback);
    return (
      <VideoPlazaModelCatalogEditor
        value={value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch4(props: ConfigValueEditorProps) {
  if (props.configKey === 'image_plaza_share_tip') {
    const parsed = ImagePlazaShareTipConfigSchema.safeParse(props.value);
    const fallback = ImagePlazaShareTipConfigSchema.parse(
      configMetadata.image_plaza_share_tip.defaultValue
    );
    return (
      <ImagePlazaShareTipEditor
        value={parsed.success ? parsed.data : fallback}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch5(props: ConfigValueEditorProps) {
  if (props.configKey === 'image_plaza_tags') {
    const parsed = EditableImagePlazaTagConfigSchema.safeParse(props.value);
    const fallback = ImagePlazaTagConfigSchema.parse(configMetadata.image_plaza_tags.defaultValue);
    const value = parsed.success
      ? parsed.data.map((tag) => ({
          ...tag,
          group_id: tag.group_id ?? IMAGE_PLAZA_DEFAULT_TAG_GROUP_ID,
          group_label: tag.group_label ?? IMAGE_PLAZA_DEFAULT_TAG_GROUP_LABEL,
          group_sort_order: tag.group_sort_order ?? 0,
          group_layout: tag.group_layout ?? ('chips' as const),
        }))
      : fallback;
    return (
      <ImagePlazaTagsEditor value={value} disabled={props.disabled} onChange={props.onChange} />
    );
  }
  return null;
}

function renderBranch6(props: ConfigValueEditorProps) {
  if (props.configKey === 'reply_style_options') {
    const editable = EditableReplyStyleOptionsConfigSchema.safeParse(props.value);
    if (!editable.success) {
      return (
        <Alert type="error" showIcon message="回复风格配置格式有误，请撤销编辑或回滚到有效版本。" />
      );
    }
    return (
      <ReplyStyleOptionsEditor
        value={editable.data}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch7(props: ConfigValueEditorProps) {
  if (props.configKey === CREATOR_REVIEW_PROMPT_KEY) {
    return (
      <CreatorReviewPromptEditor
        value={typeof props.value === 'string' ? props.value : ''}
        disabled={props.disabled}
        onChange={props.onChange}
        onTest={props.onTestCreatorReview}
      />
    );
  }
  return null;
}

function renderBranch8(props: ConfigValueEditorProps) {
  if (props.configKey === FREE_ZONE_CONFIG_KEY) return <FreeZoneConfigEditor {...props} />;
  return null;
}

function renderBranch9(props: ConfigValueEditorProps) {
  if (props.configKey === DRIVE_MODE_OPTIONS_KEY) return <DriveModeOptionsEditor {...props} />;
  return null;
}

function renderBranch10(props: ConfigValueEditorProps) {
  const dedicatedEditor = dedicatedConfigEditor(props);
  if (dedicatedEditor) return dedicatedEditor;
  return null;
}

function renderBranch11(props: ConfigValueEditorProps) {
  if (props.configKey === 'system_instructions') {
    return (
      <SystemInstructionsEditor
        value={typeof props.value === 'string' ? props.value : ''}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch12(props: ConfigValueEditorProps) {
  if (props.configKey === 'choice_rules') {
    const fallback = configMetadata[props.configKey].defaultValue as InstructionSlotRules;
    const parsed =
      props.value && typeof props.value === 'object' && !Array.isArray(props.value)
        ? (props.value as Partial<InstructionSlotRules>)
        : {};
    return (
      <PlatformInstructionSlotRulesEditor
        value={{
          on_first_two_turns: parsed.on_first_two_turns ?? fallback.on_first_two_turns,
          on_later_turns: parsed.on_later_turns ?? fallback.on_later_turns,
          off: parsed.off ?? fallback.off,
        }}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch13(props: ConfigValueEditorProps) {
  if (props.configKey === 'pref_word_count_tiers') {
    return (
      <WordCountTiersEditor
        value={asWordCountTiersConfig(props.value)}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch14(props: ConfigValueEditorProps) {
  if (props.configKey === 'lobby_ranking_params') {
    return (
      <LobbyRankingParamsEditor
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}

function renderBranch15(props: ConfigValueEditorProps) {
  if (
    props.configKey === 'miniapp_new_user_signup_bonus_credits' ||
    props.configKey === 'miniapp_checkin_new_user_credits' ||
    props.configKey === 'miniapp_checkin_veteran_credits'
  ) {
    return (
      <InputNumber
        min={0}
        precision={0}
        value={typeof props.value === 'number' ? props.value : 0}
        disabled={props.disabled}
        onChange={(value) => props.onChange(value ?? 0)}
      />
    );
  }
  return null;
}

function renderBranch16(props: ConfigValueEditorProps) {
  if (props.configKey === 'llm_pricing_config') {
    return (
      <LlmPricingConfigEditor
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return null;
}
