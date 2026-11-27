import type { NotificationScope } from '@miniapp/shared';

export interface MessageListView {
  scope: NotificationScope;
  olderExpanded: Record<NotificationScope, boolean>;
}

/**
 * 列表和详情是两个路由，返回时列表会重新挂载、丢掉分类和展开状态。
 * 只在「从详情返回」这一条路径上恢复；从「我的」等入口进来仍是默认视图。只放内存，刷新即丢。
 */
let saved: MessageListView | null = null;
let returning = false;

export function rememberMessageListView(view: MessageListView): void {
  saved = view;
  returning = false;
}

export function markReturningToMessageList(): void {
  returning = saved !== null;
}

/** 只读不清：useState 初始化在开发模式下会调用两次，清理放到挂载后的 effect 里。 */
export function peekMessageListView(): MessageListView | null {
  return returning ? saved : null;
}

export function clearMessageListView(): void {
  saved = null;
  returning = false;
}
