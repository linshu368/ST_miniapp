import { Space, Switch, Typography } from 'antd';

import { InviteCenterConfigEditor } from './InviteCenterConfigEditor';

import type { ConfigValueEditorProps } from './config-value-types';
import { asInviteCenterConfig } from './config-value-helpers';

export function renderConfigGroup3(props: ConfigValueEditorProps) {
  const result20 = renderBranch20(props);
  if (result20 !== null) return result20;
  const result21 = renderBranch21(props);
  if (result21 !== null) return result21;
  return null;
}

function renderBranch20(props: ConfigValueEditorProps) {
  if (props.configKey === 'miniapp_invite_center_config') {
    return (
      <InviteCenterConfigEditor
        value={asInviteCenterConfig(props.value)}
        disabled={props.disabled}
        onChange={props.onChange}
        onUploadPoster={props.onUploadInvitePoster}
      />
    );
  }
  return null;
}

function renderBranch21(props: ConfigValueEditorProps) {
  if (props.configKey === 'miniapp_invite_entry_enabled') {
    const enabled = props.value === true;
    return (
      <Space align="center" size="middle">
        <Switch
          checked={enabled}
          disabled={props.disabled}
          onChange={(next) => props.onChange(next)}
        />
        <div>
          <Typography.Text strong>{enabled ? '入口已开启' : '入口已关闭'}</Typography.Text>
          <br />
          <Typography.Text type="secondary">
            关闭时 C 端「我的」页卡片、充值页快捷入口与星尘不足弹窗按钮全部隐藏。发布后生效。
          </Typography.Text>
        </div>
      </Space>
    );
  }
  return null;
}
