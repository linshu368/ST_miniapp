# 轻量执行清单

## 主路径与工作量

- P0（Done）：登记已确认需求、复用调研和 TEST 连接限制；最新已确认按整部剧首次上架，等待最终规划审核，不 task.py start。
- P1（Done，约 1 轮）：核对正式 TEST 的 dramas/videos/ai_results 列、FK、ACL/RLS、时间现状及存量规模。MCP 只做确认目标后的 catalog 采集；当前不可访问正式 TEST，不换库。改走获准 TEST 连接或用户提供的结构结果，不泄漏连接信息。
- P2（本地完成／远端待审阅，约 1 份迁移）：在 packages/shared/migrations/ 新增日期命名 SQL；拟在 drama_archive.videos 增加 created_at timestamptz，语义为本模块展示使用的首次上架时间。未来上传脚本在首次成功上传时写入，重试/转封装不覆盖；不设 now() 默认值冒充上传成功，脚本接入前新视频可为空并排在最新末尾。
- P3（Done，约 3–4 个代码文件）：shared DramaSummary 扩展剧级时间字段；repository 通过 drama_id 获取剧级 AI；assemble 统一回退并取可播视频的最早时间作为剧级首次上架时间。逐集 DTO 保留视频原始信息，剧级 AI 不冒充每集独有内容。复用现有三个路由、envelope、鉴权、查询超时和签名逻辑。
- P4（Done，实际 3 个前端文件，含浏览队列接线）：复用现有 React Query 列表数据，补必要检索入口，接通分类/最新按钮。关键词 trim 后忽略大小写，逐字段子串匹配；分类条件和输入词各自匹配三字段，再取交集；“全部”不增加条件。不重做布局或播放交互。
- P5（本地验证／文档完成；远端及真机待验收，约 1 轮）：验证并记录 TEST 迁移结果；同步 README、ARCHITECTURE 与相关专题 spec 的字段/发布约定。新增永久测试文件须先按风险评估纳入审核，本轮不默认新增。

## 迁移、发布与恢复

- 只走正式 TEST 的 db-migrate.yml 手工单文件流程，核对 project ref、repo_migrations 文件名/checksum。审核前不创建 SQL、不执行工作流；Production 另行审批。
- 先明确本批存量集合/规模，在事务和有限锁/语句超时下冻结候选，防止并发导入改变序号。按 source_id、message_id 编号，该组合已有唯一约束；不按物理行序。
- 时间为 2026-10-20 11:00:00+08 加 (序号-1)×10 分钟，只填 NULL。先对确认的整批编号，不对每次剩余 NULL 子集重新编号；已有非空值与批次预期冲突、shape/规模不符、锁超时均停止，不覆盖修平或盲目 force_rerun。
- 用 SQL 断言验证覆盖、首条和间隔，无须导出视频明细；权限/RLS 不变。MCP 不读取业务行；敏感导出、来源定位明细和 secret 不进入 Git。
- 核验归档 007 剧级 AI shape 已落库后再切换取数，未完成则先解决依赖；不复制 007 建平行 migration，不改历史 SQL、归档函数或上传状态。
- 先迁移验收再部署消费者。SQL 事务失败整笔回滚；应用问题回退应用并保留时间数据；已提交误填用审核后的定向 forward-fix，不自动 DROP 列/清空时间。
- 前端检索要求完整目录；检查顶层/嵌套结果截断，确有截断则在现有 repository 补齐读取，不新增公开分页。若需大幅改造，按规模证据说明额外工作量后再拍板。

## 验证命令与场景

- pnpm lint:migrations
- pnpm --filter @miniapp/shared test
- pnpm -r typecheck
- pnpm --filter @miniapp/backend test
- pnpm --filter @miniapp/frontend test
- pnpm --filter @miniapp/frontend lint
- pnpm build
- 人工：三字段独立命中、空搜索、无结果、组合筛选、推荐/最新切换、时间缺失/相同、列表详情一致、首集/选集播放、原始/AI 部分缺失与全空。
- SQL：首条时区、相邻 600 秒、候选覆盖、非空值不变、并发导入边界、前置 shape 不符拒绝、锁等待与事务恢复。在隔离环境验证失败路径，记录真实 TEST 限制。

## 暂缓与执行记录

- 最新已确认取可播视频最早时间（首次上架）。后续连载新增集数应进入最新，调整为最近更新排序；本版暂缓，不增加额外框架或状态源。
- 历史连接限制已解除：本轮通过 ST_telegrambot 的 testdb 分支定位正式 TEST，并完成 P1 核验；不沿用旧项目参考作为本库证据。
- 独立归档项目后续接入时间写入；收藏/历史/跨设备续播等范围见 PRD，不另建 backlog。
- 2026-10-26：用户确认 TEST、source_id/message_id 升序及轻量任务；本轮完成规划，未实施。
- 2026-10-26：用户确认首次上架排序及后续连载更新方向；重试插件连接后仍无法访问正式 TEST，已更新本轮证据，未发起业务 SQL。

## 本次执行基线（2026-10-26）

- 用户已明确授权按此轻量计划实施；保持 PRD + task.md，不补复杂任务文档、不拆子任务。
- P1 已核验：正式 TEST 为 ST_telegrambot/testdb（zoqelpfhurwehlvypryl）；MCP 仅查询 catalog，未读业务行。dramas.tags/description 与 ai_results.drama_id PK/FK 已落库；videos.created_at 缺失；videos(source_id,message_id) 唯一且非空；全五表 RLS 开启、无 policies。既有 service_role 表级读写授权保持。
- 服务端 HTTP HEAD/嵌套 count 只读结果：69 部剧、577 条视频、5 条剧级 AI，单剧最多 156 条视频。无顶层/单剧 1000 行截断证据，沿用现有嵌套读取，不增加分页框架。迁移锁住 videos 后要求总量仍为 577；变化就拒绝并重新审核批次，不盲改范围。
- 复用现有 DramaRepository、assemble 的逐字段回退工具、三个 routes、React Query hooks、Input 和当前列表布局；不新建状态源/公开 API/依赖。剧级 AI 只进入剧级 DTO；单集保留自身原始元数据。
- 迁移仅新增 nullable timestamptz 列，无默认值；同一事务用临时快照固定整批序号、只补 NULL，已有非空时间冲突拒绝；5s 锁/60s 语句预算，容量固定 577。无外部重试、限流/补偿组件需求；失败回滚，未知结果查账本；保留既有 ACL/RLS/播放就绪事实。
- 回退应用保留新列/时间；禁止回退到依赖已移除的视频级 AI 关系的旧 Backend。部署先 TEST migration 验收，再 Backend，再 Frontend；Production 不执行。
- 测试必要性：本次不创建永久测试文件。复用现有 tests；通过隔离 PG17 临时数据库验证迁移成功/冲突/shape/规模/锁超时/事务回滚，通过临时合成 fixture 验证剧级回退、时间聚合与前端组合筛选，不读取真实内容。
- GitHub CLI 在允许网络后登录正常。TEST 本地直连认证失败，改用 HTTP 精确计数；远端写入仍只走 db-migrate.yml。未提交的 SQL 不能被 workflow 读取，先完成全部本地实现与验证，最终审阅后再决定 commit/push 和 workflow 执行。

- 本次本地实现、检查与浏览器验证已完成，最终结果及剩余远端门禁见 verification.md；任务继续保持 in_progress，不把本地通过写成远端已执行。
