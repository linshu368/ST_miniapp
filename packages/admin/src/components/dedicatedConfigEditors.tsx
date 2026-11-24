import type { ReactElement } from 'react';
import { CHAT_RECOVERY_CONFIG_KEY } from '@miniapp/shared';
import { memoryConfigEditor } from './StoryMemoryEditors';
import { ChatRecoveryConfigEditor } from './ChatRecoveryConfigEditor';

/** 有专门编辑器的托管配置（长期记忆 / 记忆栏 / 状态栏模型 / 出字后兜底）；其余 key 返回 null。 */
export function dedicatedConfigEditor(props: {
  configKey: string;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}): ReactElement | null {
  if (props.configKey === CHAT_RECOVERY_CONFIG_KEY)
    return (
      <ChatRecoveryConfigEditor
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  return memoryConfigEditor(props);
}
