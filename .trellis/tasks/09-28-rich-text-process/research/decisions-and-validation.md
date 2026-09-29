# 决策与验证记录

## 已确认

- 用户授权本轮创建/编写 Trellis 规划。
- 使用受限制 HTML 模板和隔离 CSS；安全稳定前提下最大化运营便利。
- 原文保留、显示派生、shared 契约、真实共用渲染、版本固定、显式发布/回滚。
- 当前仓库 dispatch_mode=inline；任务已获批并进入实施，本轮 T0 未派发子代理。

## 提交规划审阅的确定默认

- 只处理新模型回复/重生成，不处理人工开场白/旧 null 版本消息。
- 仅最新完整回复且会话空闲可选，发送后禁用；Admin 为本地模拟。
- 卡片起始模板默认折叠，可配置；流式未闭合显示原文。
- source/version 快照永久保留首期，引用不可删除；回滚新发布。
- 新小型 reply-renderer 包共享实际渲染；shared 不包含 React 组件。
- 不新增 import/export 或真实模型预览调用；已有指令入口独立。

上述默认与产品文档一致或为满足验收的最小方案，一并接受文档审阅；如用户调整，更新 PRD/design，不静默变更实施。

## 技术/环境待验证（不是产品待拍板）

T0 已完成：AST 依赖/兼容、CSS 允许清单、可信 Markdown 合成、两端 Worker 打包、Node 可终止执行和保守预算见 `t0-technical-validation.md`。物理 Telegram 设备性能不伪装为本地 Chromium 结论，保留 T7 发布门禁。
T2：TEST/Production 结构和授权各自确认、view 固定列、RPC 签名/会话锁、CAS/idempotency、锁与 FK 验证策略。
T7：Telegram 设备、主题/字体/安全区、两端同输入渲染、真实发送异常、计费/语音/图片消费者。

## 规划检查结果

规划阶段只运行 task/context/module/path/JSON/格式与 git diff 检查。T0 又在隔离临时目录完成 Node/Vite/Next/Chromium 技术验证；仓库仍无产品变更，因此没有运行产品 typecheck/tests，且不把 T0 原型检查当作 AC10 已通过。后续由 T1–T7 执行既有及规划明确提出的必要高风险回归检查。

- `task.py validate`：通过，implement/check 各 23 个真实规范/研究条目，所有引用路径存在。
- 元数据检查：通过，状态 in_progress、分支/base 正确，9 个 module_impact IDs 均在当前模块索引注册，relatedFiles 和 JSONL 语法有效。
- T0：`node node-probe.mjs`、`pnpm build:vite`、`pnpm build:next` 与 390×844 Chromium probe 通过；详细数据见 `t0-technical-validation.md`。
- `pnpm exec prettier --check .trellis/tasks/09-28-rich-text-process`：通过。
- `git diff --check`：通过；该命令不覆盖 untracked 文档，新增文档由 Prettier 和独立尾随空白检查验证。
- Git 状态：仅同名任务目录 untracked；没有产品文件变更，任务已 start，未 commit/push。
