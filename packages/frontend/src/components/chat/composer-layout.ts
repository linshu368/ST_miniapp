/**
 * 输入框「单行胶囊 ↔ 上下两栏」的切换判定，取值照搬原版
 * （st-extension/src/patches/mobile-chat-theme.ts 的同名函数，此处不引用它，只对齐行为）。
 *
 * 单独成文件是为了能被测试直接导入：组件是 tsx，纯函数留在里面就只能连着 JSX 一起加载。
 *
 * 收起的阈值比展开的高（24 vs 12），是一段迟滞：两个阈值取同一个数的话，
 * 光标停在临界长度上删一个字、打一个字，布局就会来回跳。
 */
export function shouldExpandComposer(
  value: string,
  scrollHeight: number,
  currentlyExpanded: boolean
): boolean {
  if (value.includes('\n')) return true;
  if (currentlyExpanded) return value.length > 12 || scrollHeight > 54;
  return value.length > 24 || scrollHeight > 54;
}

/** Enter confirms an IME candidate before it can submit a chat message. */
export function isComposerSubmitKey(
  event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number },
  compositionActive: boolean
): boolean {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    !compositionActive &&
    event.keyCode !== 229
  );
}

/** Both editable regions use the visible height, even when the layout viewport stays tall. */
export function composerViewportLimits(visibleHeight: number | null, layoutHeight: number) {
  const height =
    visibleHeight !== null && Number.isFinite(visibleHeight) && visibleHeight > 0
      ? visibleHeight
      : Number.isFinite(layoutHeight) && layoutHeight > 0
        ? layoutHeight
        : 640;
  return {
    textarea: Math.max(42, Math.floor(height * 0.5)),
    preferences: Math.max(0, Math.floor(height * 0.45)),
  };
}
