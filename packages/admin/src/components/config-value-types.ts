import type {
  LlmModelProvider,
  ProviderModelDirectory,
  CreatorReviewTestRequest,
  CreatorReviewTestData,
} from '@miniapp/shared';
import type { ManagedConfigKey } from '@miniapp/admin-client';
export type ConfigValueEditorProps = {
  configKey: ManagedConfigKey;
  modelCatalogSection?: 'models' | 'fallback';
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  providerDirectories: Partial<Record<LlmModelProvider, ProviderModelDirectory>>;
  publishedModelIds: ReadonlySet<string>;
  syncLoading: Partial<Record<LlmModelProvider, boolean>>;
  syncError: Partial<Record<LlmModelProvider, string | null>>;
  onRefreshProvider: (provider: LlmModelProvider) => void;
  onUploadInvitePoster: (file: File) => Promise<string>;
  onTestCreatorReview: (
    input: CreatorReviewTestRequest,
    signal?: AbortSignal
  ) => Promise<CreatorReviewTestData>;
};
