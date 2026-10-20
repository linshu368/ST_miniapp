# T8 本地主表清退实现与验证（2026-10-16）

## 授权与最高约束

用户明确授权在现有规划补齐 41 / 12942 两类历史处理和“不影响正常对话及对话数据落表”约束后直接本地实施。已执行，未新建任务。未远端 migration/补写、暂存/提交/推送、PR 创建/合并、部署或归档。指定 Admin preview 文档与问题汇总保留。

## 已完成代码

- ConversationHistoryRepository 不再写主表 generation ID；主表/current 读取使用显式业务投影，不再 SELECT \* 顺带读取旧调用列。正文、prompt history、用户输入、revision、业务 llm_finish_reason 和计费事实仍由原仓储维护，公开 HTTP/SSE DTO 不变，Prisma 无 experience 映射需改。
- GenerationHooks 新增内部 onBeforeDispatch/onGenerationId；上游前 await 冻结计费快照与对应 provider 占位；header/SSE/non-stream 首次 ID await 专表持久化，NULL-only CAS、写结果未知读回、冲突拒绝、至多两次写/一次短退避、单操作 5s/ID 总预算 10s。没有再次发送上游生成请求。
- SSE 先保留已收到的正文快照，再 await ID，但 ID 成功前不回调该 delta；ID 失败传播到原清理/终态路径，不被 JSON parse catch 吞掉。包括当前 chunk 和非流式完整 body 的已接收内容都保留，不能因 metadata 异常清空正文。取消/超时与晚到 stop 仍受主表终态 CAS 约束。
- OpenRouter/Venice 分别提供专表 ID；不新增通用 provider 框架、不改 Venice mapper/表结构/计费算法。明细 upsert 不清空/替换已持久化 ID；OpenRouter 的未知 NULL 字段不覆盖既有值，0 保留。
- 恢复为五路独立预算：OpenRouter pending billing、Venice pending billing、缺失 identity、OpenRouter metadata、stale streaming，各 50/24h/DB 5s，去重与单行失败隔离。完整已存 metadata 可以完成计费恢复而不请求上游；缺 OpenRouter key 不停 Venice 或业务清理。
- 进程在 ID 落库前崩溃不能凭空找回上游 ID：stale streaming 复用 120s 超时/额度释放，已确定失败的定档调用沿原 charge_id 收口；成功但无可信事实的记录明确留待人工核验，不猜 stop、不重新生成或重复扣款。两 provider 明细/快照冲突停止该记录，不阻断其他候选。

## 新 migration 与发布顺序

文件只新增，四份历史 SQL 未修改。每份新文件均事务化，lock_timeout=5s/statement_timeout=60s，不使用 CASCADE。

1. 20261016_openrouter_retirement_catchup.sql：旧 writer 退出后，小集合（最多 2000）补安全标量/ID；有 ID 按排除 Venice 规则，无 ID 必须有可靠 OpenRouter 快照。已有非空 canonical 不被旧值反写；不复制 raw JSON/正文/业务 finish reason。重叠、ID 冲突、Venice 快照缺明细、超预算均拒绝。
2. 20261016_chat_history_provider_metadata_views.sql：current 的既有 12 个输出别名从对应 provider 专表取值，保留字段顺序/类型、DISTINCT ON/revision 基数、业务 finish reason、owner/ACL/security mode；已有 base_chat_bj 同样按 provider 取 latency。cs_persona_reader 仅在原有授权/角色存在时获得所需 OpenRouter 列权限，anon/authenticated 不放开；TEST 没有生产 view/角色的分支跳过。
3. 20261016_chat_history_drop_provider_metadata.sql：独立 DROP 恰好 12 列，保留业务终态/计费/专表旧别名。拒绝 DB 依赖、ID 冲突/未保全标量、未经审阅的任何旧 raw JSON、未收口历史计费。已使用专表、旧字段为空的正常新 streaming 调用不受历史结算门禁阻断，DROP 不修改其正文、状态或 charge_id。

实际发布为：历史四份已在两库完成 → 本轮兼容新 Backend（旧列在/不在均可运行） → 所有旧副本/worker/job 退出及请求 drain → 新 catch-up/分类核对 → 视图切换 → 四类硬门禁 → 最后独立 DROP。新 Backend 不要求先执行这三份 SQL；不能按文件名字典序跑，也不能先 DROP 再部署。

## 历史两类的落地边界

上次 Production 快照的 41 条有 ID 缺明细，是 catch-up 的可处理集合，仍需新窗口重算/冲突核验。12942 条没有 ID/明细不能直接认定没有元数据：可靠归属+安全标量可补 NULL-ID 明细，空调用事实且业务收口保留主表，未收口按原幂等键恢复，归属/内容未知阻断 DROP。TEST 165 不替代 Production。迁移中的 SQL 守卫不能代替外部审阅和所有历史分类。

**旧 raw JSON 的内容/丢弃策略没有被本次只读聚合证明。DROP 选择拒绝其非空记录，不盲迁、不自动置空。** 本地测试只对合成 fixture 注入/清除这些字段，以证明守卫有效；不能拿该过程作为生产内容处置授权。若实际缺口超过 2000，另审有界批次 forward migration，不能重跑已记账文件/调大超时硬跑。

## 本地验证结果

- Backend：84 files / 681 tests；Shared：15 files / 139 tests，全部通过。
- pnpm -r typecheck：Shared、Backend、Reply Renderer、CS、Admin、Frontend 全通过。临时扩展 tsconfig 还对本地 .mts harness 与 Backend 一起执行 tsc --noEmit，通过。
- pnpm -r --workspace-concurrency=2 --if-present build：Frontend/Admin/CS 通过；Backend/Shared/Renderer 无独立 build script。Admin 原有 bundle 大小提示不阻断。
- pnpm lint、lint:imports、lint:legacy、lint:migrations、bash -n、新旧 migration 本地验证及 pnpm test:migration-ledger 通过。ledger 脚本仅连接本机测试 PG，未远端执行。
- 新 scripts/database/test-openrouter-retirement-local.sh 在隔离 PG17 + 官方 PostgREST 16.4 通过：真正执行四前序及三新 migration，物理 DROP 12 列后，实际 Supabase client 和 repository 的 prompt/body/finalize、显式业务投影、两个 provider ID CAS/并发/冲突、NULL-ID 不清 ID、pending/missing 查询、billing outcome、cancel/late stop、上下文/最新 revision 都通过。
- SQL 负向：视图依赖未切换拒绝 DROP；未知归属未保全标量拒绝；旧 raw JSON 拒绝；历史未结算拒绝；重复 DROP 拒绝。正向保留新 streaming 调用，current/base 形状/基数/类型/NULL/0/业务终态/角色权限正确；没有 production-only analytics view/reader role 时可重建。原名 expand harness 对 11 字段、NULL/0、父表隔离/权限/约束/重放/FK 和 shape guard 通过。
- PG socket/共享内存受沙箱限制时按工具审批在沙箱外重跑，绑定本地 loopback，临时凭证环境清空。PostgREST 临时官方二进制不加入项目依赖。

本地 fixture 对 parent 的创建代表测试起点；这里没有声称完整生产开轮 RPC、真实上游、SSE 真机、钱包/额度 RPC 的故障注入或多 Railway 副本已实测。它们仍属独立 TEST/Production 验收。

## 环境与未完成门禁

交付前再次只读复核：PR429 仍 OPEN，head 50c121f4；Production deployment df7b4385-ce8f-4509-bea2-702a622eaefd / main c759f6de，SUCCESS。本轮没有部署，所以不含本地清退代码。TEST development 上次核验 50c121f4；两库四份历史账本/checksum 和规模/覆盖聚合详见 T5 审计，本轮三份新 SQL 未执行远端。

仍缺：真实 TEST 免费/付费发送与重生成、取消/超时/错误/晚到 stop、DB/计费/额度失败/重启/多副本故障注入；Production snapshot/provider 全量冲突、12942 分类/raw JSON 内容处置、41 与旧 writer 切换窗口补齐；外部分析/CS owner、所有旧副本退出、运行零旧列读写、长事务/锁/磁盘/WAL/复制预算。未通过不得执行 DROP，任务继续 in_progress。

删列后不能直接回滚 c759f6de/597df0e1 等旧 Backend；仅用在“12 列不存在”下验证的兼容 SHA 或审阅过的 forward-fix。重加空列不等于恢复旧数据，旧 raw JSON 不能靠专表还原；不执行 VACUUM FULL/表重写。

## 新 SQL checksum（本地最终文件）

- 20261016_openrouter_retirement_catchup.sql: 9473b079cbd1922777fef8deb8764a3d3349ff99a8f10de513fcf4958e0d957a
- 20261016_chat_history_provider_metadata_views.sql: 2fec4d26719a738978bb41e9f9bb9fb0d45f75d91b749af0a58ee9c9dc4f017f
- 20261016_chat_history_drop_provider_metadata.sql: 61d547e895be61993a8eff084283a8f6b1fee18327317874466057653a254131
