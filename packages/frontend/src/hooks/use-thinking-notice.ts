'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const NOTICE_MS = 2800;
export const THINKING_ALWAYS_ON_NOTICE = '当前模型不支持关闭深度思考，思考过程会照常显示';

/**
 * 有的模型（目前是畅聊里的部分免费模型）关了深度思考照样吐思考过程，用户会以为出了 bug。
 * 不维护名单：哪一轮关着开关却收到了思考过程，就在本页记住这个模型并当场轻提示一次；
 * 之后再对它点「关闭深度思考」也提示一句。刷新页面就忘掉，不追求严谨。
 */
export function useThinkingNotice(selectedModelId: string | null) {
  const alwaysOn = useRef(new Set<string>());
  // 带序号：同一句话再次触发也要重新计时
  const [notice, setNotice] = useState<{ seq: number } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const show = useCallback(() => setNotice((current) => ({ seq: (current?.seq ?? 0) + 1 })), []);

  const onThinkingIgnored = useCallback(
    (modelId: string) => {
      if (alwaysOn.current.has(modelId)) return;
      alwaysOn.current.add(modelId);
      show();
    },
    [show]
  );
  const onThinkingToggled = useCallback(
    (enabled: boolean) => {
      if (enabled) setNotice(null);
      else if (selectedModelId && alwaysOn.current.has(selectedModelId)) show();
    },
    [selectedModelId, show]
  );

  return {
    notice: notice ? THINKING_ALWAYS_ON_NOTICE : null,
    onThinkingIgnored,
    onThinkingToggled,
  };
}
