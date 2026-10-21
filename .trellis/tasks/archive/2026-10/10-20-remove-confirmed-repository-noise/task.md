# Task Breakdown

## Status Legend

- Todo: 未开始
- Doing: 进行中
- Done: 已完成并验证
- Blocked: 等待外部条件
- Skipped: 有记录地跳过

## Tasks

| ID  | Status | Task                             | Files / Scope                 | Depends On | Verification                     |
| --- | ------ | -------------------------------- | ----------------------------- | ---------- | -------------------------------- |
| T1  | Done   | 复核删除边界与 GHCR 消费者       | 全仓、GitHub workflow/配置    | -          | 引用扫描与远端只读核验           |
| T2  | Done   | 清理 Frontend 孤儿、静态图与依赖 | `packages/frontend`、lockfile | T1         | typecheck/test/lint/build        |
| T3  | Done   | 删除许愿池完整应用链             | Frontend/Backend/Shared/spec  | T1         | 残余引用扫描、三包验证           |
| T4  | Done   | 清理 Backend/运维孤儿            | Backend、Railway/env/docs     | T1         | typecheck/test、配置扫描         |
| T5  | Done   | 删除过期文档并修复规范噪音       | docs/ops/Trellis/README       | T1         | 链接与事实扫描、Prettier         |
| T6  | Done   | 全仓验证与最终审查               | 全仓                          | T2-T5      | typecheck/test/lint/build/legacy |

## Execution Log

- 2026-10-20：用户确认清理范围，并明确授权删除旧角色图、许愿池和三个过期方案文档；GHCR workflow 需复核无消费者后删除。
- 2026-10-20：仓库、Railway、Vercel、远端分支/tag、GitHub deployment 与 workflow 历史均未发现受支持的 GHCR 消费者；已删除 workflow，限制与证据见 `research/ghcr-consumer-audit.md`。
- 2026-10-20：完成 Frontend/Backend/Shared/运维/文档清理；许愿池 Prisma 映射已移除，历史 migration 与现存数据库表保留且未连接数据库。
- 2026-10-20：Backend 91 文件 723 项、Frontend 41 文件 256 项、Shared 16 文件 169 项、Reply Renderer 1 文件 32 项测试通过；全仓 typecheck、lint、import/legacy/migration guard、Frontend/Admin build、Prisma validate、触达文件 Prettier 与 `git diff --check` 通过。全仓 Prettier 仍有 14 个本轮未触达的既有格式问题。
- 2026-10-20：最终只读审查未发现高/中风险问题或残余运行时消费者；用户随后授权提交并推送，未部署。
