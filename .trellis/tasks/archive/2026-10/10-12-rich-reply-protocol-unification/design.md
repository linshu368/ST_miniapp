# Design: canonical RichReply protocol and staged V2 renderer

## Reuse research

- 复用 `packages/admin/src/lib/configSchemas.ts` 的 System Instructions Zod 边界，但把必填占位符收敛为两个。
- 复用 `SystemInstructionsEditor` 的占位符可视化与草稿/发布流程；不增加第二个配置入口。
- 复用 Backend `platform-instructions.ts` 的 runtime-config 读取、缓存和失效机制；移除 interaction mode 消费，不绕过 `platform/runtime-config.ts`。
- 复用 `render-instructions.ts` 的纯函数替换和 `$&/$1` 安全处理；删除第三个占位符替换分支。
- 复用 Shared text-postprocess 的 source/artifact 版本、HTML/CSS AST、预算、diagnostics 和完整 Markdown fallback。
- 复用 `ReplyRenderer`、可信 choice action、逐消息 scope、Worker 和历史版本绑定；扩展 artifact，而不是创建第二套渲染包。
- 复用 Admin/Backend 现有草稿、CAS 发布、request-id、不可变 snapshot 与回滚流程。
- 不复用多条正则拼装嵌套模块：当前 segment/slot 设计有意把 capture 解析为文本，无法承担递归结构协议。

## Target boundaries

```text
canonical protocol source
  ├─ System Instructions protocol fragment
  ├─ Admin preview samples
  ├─ shared valid/invalid fixtures
  └─ operator documentation

model output / provider adapter
  -> RichReplyV2 parser
  -> versioned canonical artifact
  -> ReplyRenderer
  -> Admin Preview + MiniApp
```

核心模块由 RichReplyV2 DTO 表达：`body`、固定 3 项 `choices`、可重复 `status.panels`、可重复 `memory.panels`。DTO 位于 `packages/shared/src/api/*`，producer/consumer 均做 runtime validation。

简单正文增强规则继续使用现有 regex/template/CSS 编译器，但模板和 CSS 必须在同一次编译中完成引用完整性检查；它们不能生成或修改 RichReplyV2 核心模块。

## Source-of-truth design

附件是本次审核输入。实施时将其内容导入一个版本控制内的 canonical protocol resource，并由确定性纯函数生成提示词协议片段和 fixtures。生成结果可提交，但必须带来源 identity/hash 检查，防止手改派生副本。

System Instructions 仍可保留角色扮演、字数和用户偏好段落；其中富文本输出协议只能引用 canonical source 的生成结果。这样“附件是协议事实源”不会把运行时依赖建立在用户 Downloads 路径上。

## INTERACTION_MODE retirement

发布校验按下列顺序演进：

1. forward migration 更新数据库 validator，只要求 `WORD_COUNT` 与 `USER_CUSTOM_INSTRUCTIONS`；保留旧模板也仍可发布。
2. Backend 新版本停止读取/替换 interaction mode，但对旧模板中的遗留占位符给出明确观测并 fail closed，防止字面量泄露给模型。
3. Admin 更新 placeholder schema/editor/default copy，并加载 canonical protocol。
4. TEST 发布新 System Instructions snapshot；核对实际渲染 prompt 后再允许聊天验收。

不删除 runtime-config 行和用户偏好数据，以保留旧 Backend 回滚能力。回滚 Backend 时必须同时回滚到仍含 `{{INTERACTION_MODE}}` 的旧 System Instructions snapshot。

## Reliability model

- **超时**：Worker init handshake 与 apply deadline 分离；运行超时仍 fail-open 原文。
- **有限重试**：纯预览 Worker 崩溃只重建一次；发布写入沿用 request-id/CAS，不盲重试。
- **幂等/并发**：canonical compile 为确定性纯函数；Admin publish 沿用不可变 snapshot 与 CAS。
- **事务**：validator migration 单文件事务执行；应用部署不自动执行 migration。
- **降级**：未知/非法协议、artifact 或 DOM 失败全部显示完整原文；不渲染半份模块。
- **容量**：沿用消息、节点、slot、CSS AST、diagnostic 和 deadline 预算；V2 数组和字段增加显式上限。
- **可观测性**：记录协议版本、parse/fallback reason、worker_init_ms、compile_ms、apply_ms；不得记录聊天正文。

## Minimal sufficient scope

- 不删除 `pref_show_options` 或旧 runtime-config 数据，避免把协议切换扩大为用户设置迁移。
- 不引入 iframe、第二个 renderer、第二套 Admin 发布流或新数据库表。
- 不允许模型生成任意 HTML/CSS；运营展示能力保留在受控 rule bundle 和主题层。
- 不为当前没有需求的模块建立通用插件市场或脚本运行时。

## Evolution and recovery

- RichReplyV2 采用新 schema version；消费者先发布双读，producer 后切换。
- 旧 v1 artifact 和历史消息保持只读兼容；不回填旧消息。
- 停止条件：任一 consumer 尚未兼容、TEST validator ledger 不匹配、真实 prompt 残留占位符、完整样例回退率异常。
- 回滚：停止发布 V2，回滚当前 System Instructions snapshot；数据库 validator 保持向后兼容，不需要逆 migration。
