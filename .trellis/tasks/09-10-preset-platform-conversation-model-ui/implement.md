# Preset Platform 会话与模型 UI 实施计划

## 顺序

1. 读取 SPA 基座和 backend 模型/生成契约，复核参考 HTML 图 1。
2. 实现对话测试页：左侧私有会话列表、中间消息流、右侧配置/角色/脱敏输入快捷区。
3. 实现会话 CRUD 状态、A/B 隔离、busy/失败/取消/超时/断线状态。
4. 实现 OpenRouter 模型下拉和模型目录页，参考 Admin 搜索、stale、强刷、过期展示。
5. 接入 SSE client，确保 request/session/environment 关联，迟到响应不串会话/环境。
6. 补 UI 单测和必要 E2E/人工 smoke。
7. 更新 preset-platform UI/state/testing spec。

## 验证

```bash
pnpm --filter @miniapp/preset-platform typecheck
pnpm --filter @miniapp/preset-platform test
pnpm --filter @miniapp/preset-platform build
```
