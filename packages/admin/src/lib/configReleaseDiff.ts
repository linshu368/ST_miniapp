import {
  isTextManagedConfig,
  type ConfigRelease,
  type ManagedConfigKey,
} from '@miniapp/admin-client';
import { getModelCatalogChangeSummary } from './modelCatalogDiff';

export function jsonPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function releasePreviewValue(release: Pick<ConfigRelease, 'value' | 'text_value'>): unknown {
  return release.text_value ?? release.value;
}

export function maskConfigSecret(key: ManagedConfigKey, value: unknown): unknown {
  if (key !== 'image_text_model_config' || !isPlainObject(value)) return value;
  return {
    ...value,
    api_key: typeof value.api_key === 'string' && value.api_key ? '••••••••' : '',
  };
}

export function draftSaveFields(
  key: ManagedConfigKey,
  parsed: unknown
): { value: unknown; textValue?: string | null } {
  if (isTextManagedConfig(key)) {
    return { value: null, textValue: typeof parsed === 'string' ? parsed : String(parsed ?? '') };
  }
  return { value: parsed };
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export interface ValueChange {
  path: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function collectValueChanges(
  before: unknown,
  after: unknown,
  path = '配置值',
  changes: ValueChange[] = []
): ValueChange[] {
  if (Object.is(before, after)) return changes;

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      collectValueChanges(before[index], after[index], `${path}[${index}]`, changes);
    }
    return changes;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      collectValueChanges(before[key], after[key], `${path}.${key}`, changes);
    }
    return changes;
  }

  changes.push({ path, before, after });
  return changes;
}

export function getPreviousRelease(
  allReleases: ConfigRelease[],
  release: ConfigRelease
): ConfigRelease | undefined {
  return allReleases
    .filter(
      (candidate) =>
        candidate.config_key === release.config_key &&
        candidate.runtime_version < release.runtime_version
    )
    .sort((left, right) => right.runtime_version - left.runtime_version)[0];
}

export function formatChangeValue(value: unknown): string {
  if (value === undefined) return '未设置';
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
}

export function getReleaseChangeSummary(
  allReleases: ConfigRelease[],
  release: ConfigRelease
): string {
  const previousRelease = getPreviousRelease(allReleases, release);
  if (!previousRelease) return '首次发布完整配置';
  const previousValue = releasePreviewValue(previousRelease);
  const currentValue = releasePreviewValue(release);
  if (release.config_key === 'llm_model_catalog') {
    const modelSummary = getModelCatalogChangeSummary(previousValue, currentValue);
    if (modelSummary) return modelSummary;
  }
  const changes = collectValueChanges(previousValue, currentValue);
  if (changes.length === 0) return '配置内容未变化';
  return `${changes.length} 项：${changes
    .slice(0, 2)
    .map((change) => change.path)
    .join('、')}${changes.length > 2 ? '…' : ''}`;
}
