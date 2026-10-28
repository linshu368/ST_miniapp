# Implementation plan

## Preconditions

1. 审核并确认本任务规划后才执行 `task.py start`。
2. 核对目标基线包含 `10-10-relax-rich-text-css-policy` 的 shared/renderer commits；缺失时停止并报告“缺少 T1 基线”。
3. 确认附件 `/Users/qj/Downloads/后处理规则.md` 是本次批准的精确版本，记录内容 identity，禁止从问题汇总反向推导协议。
4. 确认 TEST Supabase 目标、当前 validator definition、migration ledger、Backend/Admin/Frontend commit；Production 仅只读盘点。

## Ordered delivery

1. 建立 canonical protocol resource、identity 检查和 shared fixtures。
2. 新增 forward migration，兼容地移除数据库对 `{{INTERACTION_MODE}}` 的必填校验，并补 preflight/postflight/rollback 说明。
3. 更新 Backend instruction 类型、读取和渲染，停止 interaction-mode 依赖；补旧模板残留占位符保护。
4. 更新 Admin schema/editor/default sample/copy，使其只要求两个占位符并从 canonical fixture 读取协议样例。
5. 在 Shared 定义 RichReplyV2 schema/parser/artifact，复用现有预算与完整原文 fallback。
6. 扩展 ReplyRenderer、Admin Preview 和 Frontend consumer 的双读渲染。
7. 增加 rule bundle 的 selector-to-template 引用校验、聚合 diagnostics 和安全厂商前缀处理。
8. 完成 Worker init/apply 分段计时与一次性重建。
9. 更新 README、架构与 shared/admin/frontend/database specs。
10. 按 migration → Backend → Admin/Frontend 顺序在 TEST 验收；形成独立 Production 发布清单，不自动执行。

## Verification

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/reply-renderer test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/frontend test
pnpm -r typecheck
pnpm --filter @miniapp/admin build
pnpm --filter @miniapp/frontend build
pnpm lint:migrations
pnpm test:migration-ledger
pnpm lint:imports
git diff --check
```

人工验收覆盖：附件 3 个完整样例、System Instructions 实际渲染结果、浅色/深色、375px、流式结束、折叠状态、choice 防双击、历史 v1、Worker 冷启动、非法协议和完整原文回退。

## Required regression tests

本任务涉及安全边界、跨包契约、数据库 validator、历史 artifact 与交互发送，需在现有测试文件中补回归；仅当现有文件无法承载时再创建最小新测试文件。
