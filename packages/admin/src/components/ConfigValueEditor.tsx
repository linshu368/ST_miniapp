import { Alert, Space } from 'antd';
import { ModelCatalogSchema, type ModelCatalog } from '@miniapp/shared';
import { configMetadata, EditableModelCatalogSchema } from '@miniapp/admin-client';

import { ModelCatalogEditor } from './ModelCatalogEditor';
import { FallbackConfigEditor } from './FallbackConfigEditor';

import type { ConfigValueEditorProps } from './config-value-types';

import { renderConfigGroup1 } from './ConfigValueGroup1';
import { renderConfigGroup2 } from './ConfigValueGroup2';
import { renderConfigGroup3 } from './ConfigValueGroup3';

export function ConfigValueEditor(props: ConfigValueEditorProps) {
  const group0 = renderConfigGroup1(props);
  if (group0 !== null) return group0;
  const group1 = renderConfigGroup2(props);
  if (group1 !== null) return group1;
  const group2 = renderConfigGroup3(props);
  if (group2 !== null) return group2;
  const parsedCatalog = ModelCatalogSchema.safeParse(props.value);
  const editableCatalog = EditableModelCatalogSchema.safeParse(props.value);
  const modelCatalog = editableCatalog.success
    ? (editableCatalog.data as ModelCatalog)
    : (structuredClone(configMetadata.llm_model_catalog.defaultValue) as ModelCatalog);
  return (
    <Space direction="vertical" className="editor-stack">
      {!editableCatalog.success ? (
        <Alert type="warning" showIcon message="模型目录结构无效或尚未初始化，已载入安全默认值。" />
      ) : !parsedCatalog.success ? (
        <Alert
          type="info"
          showIcon
          message="当前模型目录尚未填写完整；内容会保留在页面，补全必填项后自动保存草稿。"
        />
      ) : null}
      {props.modelCatalogSection === 'fallback' ? (
        <FallbackConfigEditor
          value={modelCatalog}
          onChange={props.onChange}
          disabled={props.disabled}
          directory={props.providerDirectories.openrouter}
          loading={props.syncLoading.openrouter}
          error={props.syncError.openrouter}
          onRefresh={() => props.onRefreshProvider('openrouter')}
        />
      ) : (
        <ModelCatalogEditor
          value={modelCatalog}
          onChange={props.onChange}
          disabled={props.disabled}
          providerDirectories={props.providerDirectories}
          publishedModelIds={props.publishedModelIds}
          syncLoading={props.syncLoading}
          syncError={props.syncError}
          onRefreshProvider={props.onRefreshProvider}
        />
      )}
    </Space>
  );
}
