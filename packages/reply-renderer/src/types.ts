export interface ReplyChoicePayload {
  text: string;
  ruleId: string;
  start: number;
  end: number;
}

export interface ReplyRendererProps {
  content: string;
  /** 已发布的 compiled artifact。缺失时只走普通 Markdown，不启动 Worker。 */
  artifact?: unknown;
  streaming?: boolean;
  displayName?: string | null;
  theme?: 'light' | 'dark';
  choiceDisabled?: boolean;
  /** 只接收受控选项文本和规则位置，不接收 DOM event。 */
  onChoice?: (choice: ReplyChoicePayload) => void;
  /** 稳定消息身份。details 展开状态和 CSS scope 都挂在它上面。 */
  messageKey?: string;
  className?: string;
}
