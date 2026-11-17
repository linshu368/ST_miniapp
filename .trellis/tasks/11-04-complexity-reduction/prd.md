# 降复杂度专项（业务体验/稳定性/性能不变）

## Goal

在业务体验基本不变、稳定性与性能不受影响的前提下，降低主项目的整体复杂度。读者同时是工程师和后续开发用的 AI（Claude Code / Codex），衡量标准是"改一个功能需要读多少代码"。方案已在 2026-11-04 与项目负责人对话中确认。

## 现状基线（2026-11-04，origin/dev f8213128）

- 业务代码约 12 万行（frontend 45.7k / backend 41.4k / shared 12.5k / admin 12.1k），测试约 5.8 万行；近 60 天 627 次提交。
- 超过 300 行的函数 33 个，超过 150 行的 105 个，超过 80 行的 244 个；超过 800 行的文件 24 个。
- 对话主链路（聊天页 → use-conversation-turn → conversations route → generate → execute / first-token-fallback / sync-job / settle → ConversationHistoryRepository）约 8000 行，是 60 天内改动最频繁的区域；`executeGeneration` 559 行、`forwardWithFirstTokenFallback` 507 行、`runConversationTurn` 504 行。
- 前端巨型组件：`DramaPlayer` 1419 行（21 useState / 34 useRef / 19 useEffect）、`CharacterEditor` 1061、`useConversationTurn` 957、`CharacterGallery` 906、admin `AdminWorkspace` 954。
- 埋点/观测代码约 1.19 万行（约占业务代码 10%），至少 5 条管道。
- AI 文字层噪音：`.trellis/tasks` 7.3MB；搜 `first-token-fallback` 命中代码 7 个文件，命中文档/任务 50 个。README 约 40 段发布状态说明。
- 分层规则与代码不一致：31 个 route 中 16 个直接 import repository、8 个直接查库；18 个文件绕过 runtime-config 读 `process.env`。

## 阶段与子任务

| 阶段 | 内容                                                                                                                                                                                            | 风险         | 子任务                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| P0   | 复杂度报告 + 文件/函数长度预算（棘轮：新增超标阻断，存量只减不增）                                                                                                                              | 运行时零风险 | `11-04-complexity-p01-budget-docs`             |
| P1   | AI 文字层减噪：README 只保留入门；`.ignore` 隐藏归档任务；Trellis 按 14 天归档；`CLAUDE.md` 引用 `AGENTS.md`                                                                                    | 运行时零风险 | 同上                                           |
| P2   | 埋点与死代码清理：删除前端/后端 PostHog、短剧计时 Supabase 写入残留、短剧计时双轨旧轨；删除 knip 确认的未用文件/导出；`process.env` 收口；ui-tests fixture 按域拆分；route 直连 DB 加 lint 棘轮 | 低           | `11-04-complexity-p2-telemetry-cleanup` 及后续 |
| P3   | 后端对话主链路拆函数：编排函数保留为可读步骤序列，纯逻辑抽出；await 顺序和 DB/RPC 次数不变                                                                                                      | 中           | 待建                                           |
| P4   | 前端巨型组件拆分：状态机/埋点/接线分层，渲染树不变                                                                                                                                              | 中           | 待建                                           |

## 用户已确认的决定

- 死代码与生产未生效代码直接删除（多为旧版本被新版迭代后未删）。
- 前端 PostHog 整套删除（录屏与 Sentry Replay 重复；以后需要再重新接）。
- 短剧计时双轨验证已结束，旧轨可处理；当前 Cloudflare 小批量线上 AB 试验依赖的 Faro 字段必须保持。
- Grafana 过期看板可删（2026-11-04 已删 9 个；`chat-first-token-manual` 待工程｜02 链接移除后再删）。
- Trellis 任务按最后改动超过 14 天归档，不按"已合并"。
- README 中对后续无影响的发布说明直接删除。

## 约束

- 每个 PR 只做行为不变的重构或已确认的删除，不改 API 契约、数据库结构或业务逻辑；纯移动与改写分 commit。
- 不统一 Prisma/Supabase 数据访问，不做大规模目录搬迁，不引入 DI 框架或新抽象层。
- 每个 PR 运行受影响包 typecheck、相关测试、lint、build；跨包改动运行 `pnpm -r typecheck`。
- 主链路（P3/P4）上线后对比首字 P95、超时率、错误率和 Android/iOS 页面 P95。

## Acceptance Criteria

- [ ] P0：复杂度报告可重复运行；CI 阻断新增超标文件/函数。
- [ ] P1：README 不再包含发布状态说明；AI 默认搜索不命中归档任务；有可用的 14 天归档命令。
- [ ] P2：PostHog、短剧计时写库残留与双轨旧轨代码移除，生产 Faro/Sentry 数据无回退。
- [ ] P3/P4：目标函数拆分后最长函数显著下降（具体目标在子任务定），线上指标不退化。
