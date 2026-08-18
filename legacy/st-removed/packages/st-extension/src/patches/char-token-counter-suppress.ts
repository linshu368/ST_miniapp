/**
 * st-extension / patches / char-token-counter-suppress.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 行为从 extension 侧调整。
 *
 * 优化目标（iframe 加载耗时 P1-H2 瘦身）：切角色/建新对话的关键路径上，
 * ST 会给「角色编辑面板」的 ~10 个表单字段逐个算 token 数
 * （vendor scripts/RossAscends-mods.js RA_CountCharTokens：遍历
 * `[data-token-counter]` 节点、对每个字段 await getTokenCountAsync 串行）。
 * 平台 ST 固定 custom chat completion 源（OpenAI 族 tokenizer），每次计数都是
 * 一次远程 /api/tokenizers/openai/count 往返 —— 10 × 手机↔SG RTT ≈ 1~1.5s，
 * 全部花在给 miniapp 里永远不可见的编辑面板 UI 算数字上。
 *
 * 修复方式：移除 DOM 中所有 `data-token-counter` 属性。
 * RA_CountCharTokens 开头 `document.querySelectorAll('[data-token-counter]')`
 * 找不到目标 → 循环零次执行 → 零远程调用。这些节点来自 ST 静态模板
 * （index.html 角色编辑表单），init 时已在 DOM；APP_READY 再补一次兜底。
 * 影响面：仅编辑面板上的 token 数字不再显示（面板在 miniapp 中本就隐藏）。
 */

import '../st-types.js';

function stripTokenCounterAttributes(): void {
  try {
    document.querySelectorAll('[data-token-counter]').forEach((el) => {
      el.removeAttribute('data-token-counter');
    });
  } catch {
    /* best-effort：失败仅意味着本次仍走原生计数，不影响功能 */
  }
}

/** 安装「角色编辑面板 token 计数」抑制补丁。 */
export function installCharTokenCounterSuppress(): void {
  stripTokenCounterAttributes();
  try {
    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.APP_READY, stripTokenCounterAttributes);
  } catch {
    /* getContext 未就绪时依赖 init 时已执行的那次 */
  }
}
