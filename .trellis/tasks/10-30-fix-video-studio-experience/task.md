# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                  | Files / Scope                   | Depends On | Verification                                 |
| --- | ------ | ----------------------------------------------------- | ------------------------------- | ---------- | -------------------------------------------- |
| T1  | Done   | 修正 Venice queue duration wire format 并补强既有回归 | backend video-upstream + test   | -          | targeted test + typecheck                    |
| T2  | Done   | 消除终态 attempt N+1 与消息 O(n²) 查找                | frontend API + studio page      | T1         | typecheck + existing tests                   |
| T3  | Done   | 按需加载低频面板并优化模型 Sheet / 长标题 header      | studio page + video-model-sheet | T2         | lint/build + @image + manual narrow viewport |
| T4  | Done   | 全量验证、规范审查与任务记录                          | affected packages + Trellis     | T1-T3      | commands in implement.md                     |
| T5  | Done   | 修复固定有声模型 400 并补齐安全上游诊断               | backend upstream + tests        | T1         | targeted test + Railway evidence             |
| T6  | Done   | 缩短 worker claim/poll/存储的人为等待                 | backend job/repository          | T5         | tests + typecheck + log review               |
| T7  | Done   | 提交后即时写入会话并统一视频状态轮询                  | shared contract + frontend API  | T5         | shared/frontend tests + typecheck            |
| T8  | Todo   | 跨包验证与 PR-566 手工 canary 交接                    | affected packages + Trellis     | T5-T7      | commands in implement.md                     |

| T9 | Done | Audit six enabled product models against Venice modes | live config + provider catalog | T5 | capability matrix and flow trace |
| T10 | Done | Fix I2V provider fields and regenerate original params | backend adapter + frontend API/studio | T9 | targeted tests + typecheck/build |

## Execution Log

- 2026-10-30：Railway PR-566 证实 route 202、worker Venice queue 400；官方契约确认 duration 必须为 `<n>s` 字符串。
- 2026-10-30：复用/可靠性/最小方案/恢复/验证门禁已写入 design.md 与 implement.md，待开始实现。
- 2026-10-30：实现 provider 边界格式化、终态 attempt cache seed、O(n) prompt 映射、低频面板动态加载及 Sheet/Header 布局优化。
- 2026-10-30：后端定向测试 3/3、前端测试 652/652、typecheck、lint、build、`@image` 8/8 与 `git diff --check` 通过；lint 仅有既有 `<img>` 警告。
- 2026-10-30：任务 context 校验通过；module knowledge 检查被仓库既有 `frontend/app/modules/index.md` 索引漂移阻断，本任务声明不改变模块知识且未重建无关索引。
- 2026-10-30：提交 `9e42ad6b` 已部署；MiniMax H3 Max 10s/1080P/audio=true/t2v 仍 400，排除旧部署与 duration 未生效。
- 2026-10-30：Venice 当前 Queue 文档与公开 model catalog 证实该模型固定有声，`audio` 只适用于可配置模型；补充二次故障与端到端延迟方案，进入 T5。
- 2026-10-30：完成固定音频字段兼容、脱敏 provider 诊断、worker 主动唤醒、5–10 秒 provider poll、并发存储、提交后即时会话缓存和前端 2–5 秒状态同步；T5–T7 验证通过。
- 2026-10-30：shared 200/200、backend 1140/1140、frontend 655/655、workspace typecheck、frontend lint/build、`@image` 8/8 与 `git diff --check` 通过；T8 保留 PR-566 部署后的真实付费 canary。
