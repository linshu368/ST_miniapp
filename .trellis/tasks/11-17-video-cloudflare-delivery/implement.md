# 执行计划与验收

## 规划/开始门禁

- [x] 需求已收敛：未来生成统一Stream、无旧播放兼容、TEST全部13条迁移、日志接入、生产不操作。
- [x] 已记录复用调研、数据库坐标、可靠性、简洁方案、恢复及双端P95和日志声明。
- [x] 用户于2026-11-17在最终摘要后回复“开始执行”；task.py start已通过。

## 分步实施

1. 核对结构来源并更新registry：登记已有video表和新video_delivery_jobs，明确owner/生命周期/跨域引用。新schema迁移和SQL测试先在隔离数据库验证。
2. shared先定义HLS playback、artifact刷新/下载状态、严格播放观测DTO；更新所有producer/consumer，不保留MP4 video_url别名。
3. 抽出最小Stream签名/HLS装载原语，短剧调用行为保持；新服务环境配置由runtime-config唯一读取，受理前校验可用性。
4. 实现上传/编码交付worker与J表租约、上传checkpoint、状态轮询、封面Supabase存储、原子发布与失败/退款对账。停止Supabase MP4写入。
5. 实现按artifact取址/下载权限，覆盖种子无attempt场景；工作室/详情/HLS刷新/ABR/下载状态及缓存消费一起调整。
6. 接入Pino/transport/job、中文标签、允许字段、适用规则和前端观测接收；修正business_module，验证实际JSON及敏感信息禁区。
7. TEST迁移工具提供preflight/upload/verify/SQL生成/cleanup分段、固定TEST project/account/13条摘要、幂等checkpoint和安全报告。复用现有processed manifest与已核验源；不在Git保存敏感导出或签名URL。
8. 全面本地验证后，按现有workflow和最终文件审查发布TEST schema -> 上传核验13条 -> 数据切换 -> 新应用 -> contract收缩 -> 13/13人工验收 -> 清理原13个MP4，保留封面和恢复副本。生产不动。

## 可执行检查

- pnpm --filter @miniapp/shared test
- pnpm -r typecheck
- pnpm --filter @miniapp/backend test src/features/image-plaza src/features/drama src/platform/observability
- pnpm --filter @miniapp/frontend test
- pnpm --filter @miniapp/frontend lint
- pnpm --filter @miniapp/frontend build
- pnpm --filter @miniapp/admin build（共享契约消费者）
- pnpm lint:backend-logging && pnpm lint:complexity && pnpm lint:db-contract && pnpm lint:legacy && pnpm lint:migrations
- pnpm test:ui:fixtures
- pnpm test:ui --grep '@image|@drama'
- python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-17-video-cloudflare-delivery
- git diff --check
  Windows重复Next build先按spec把standalone移到workspace内output/build-snapshots，禁止递归清理junction。Linux专用数据库脚本或权限测试若本机不可用，记录受控环境验证，不能跳过断言后宣称通过。

## 必须覆盖的失败路径

- 上传创建/分块超时、会话已建但响应丢失、429及有限退避、重复worker、租约过期和进程重启：同一任务不重复模型计费、不盲目创建新云资产。
- Cloudflare处理中/只部分档位就绪/无有效分片/编码失败/超过deadline：UI不伪造ready；确定未发布失败退款一次。
- publish响应未知、退款与迟到publish竞争、补偿失败：回读/事务CAS，资产不被误删，无重复账务。
- 私有本人、公开种子/分享、其他人私有产物、非法artifact、签名过期：权限不扩大，刷新有限且保留位置；旧媒体迟到不抢回。
- MP4下载尚未生成、下载失败、Telegram拒绝保存：明确处理中/失败、保留已有降级操作，不阻塞HLS。
- HLS首帧、seek、stall、断网、后台/离页、低档起播与升降档；390/320尺寸；真实iOS/Android引擎分别确认。
- 日志使用真实formatter检验白名单字段、可信关联、并发隔离、一次终态和脱敏；观测接收拒绝客户端身份/URL/额外字段，日志/告警失败不改变业务结果。
- 迁移错环境/错账户/源集合不是13/重复UID/hash变化/少一条未就绪：拒绝切换；13行CAS事务失败不部分更新；cleanup严格限制原13个MP4，封面及短剧不动。

## 测试文件必要性

优先扩展video-upstream、repository.list-works、config、storage、stream/manifest-cache、前端image-plaza、drama-media-source及既有image/drama.spec。新delivery worker和新SQL租约/退款竞争没有同等覆盖，规划允许新增最小协议/状态机测试及隔离PG脚本；测试验证外部协议与故障不变量，不照抄内部实现。

## 证据与收尾

保存不含secret的stage/计数/时延、13/13校验与恢复摘要；真实Cloudflare处理、码率、权限、下载、真机和P95分别标注已验或未验。本功能纳入既有@image，并用@drama锁定复用回归。完成后更新相关spec/README/架构与module-updates，再按最终内容审核暂存/提交，未经明确授权不推送。

2026-11-17用户执行中明确“不需要本地UI验证测试”：停止本地UI验收，保留现有fixture契约适配，不再继续Windows预览环境排查。UI未完成，不作为通过证据；类型/单测/构建与真实Cloudflare校验继续。

## TEST 预览详情 503 排查与恢复（2026-11-17）

- 已部署 SHA 为 `73056646`，`pr-566` 的健康检查 200，指定视频详情复现 `IMAGE_PLAZA_UNAVAILABLE`/503。
- Railway 环境变量清单缺少全部 DRAMA_STREAM 签名配置及 Cloudflare 管理配置。源码在详情签发链接时要求前者；本地 `.env` 不会随镜像进入 Railway。
- 复用用户指定的本地 Backend `.env`，仅补齐 `pr-566` Backend 的三项签名配置及账户/管理 Token，共五项。通过现有 getter 校验签名与管理配置；不改产品契约、数据库、认证开关或其他环境。
- 五项一次性提交，更新值的操作可安全重复；变更后等待同一已部署构建重启，核验 health、原失败详情、全部公开视频作品取址以及每个 HLS 主清单/实际分片；未取得实际响应不宣称恢复。部署失败保留已部署构建与云端资产，先检查配置，不重跑数据迁移。
- 日志复用 `image_plaza.request_failed`、HTTP 终态和 `video.delivery.manifest`；只记录状态/结果/时延/计数和已有 request/trace，不保存私钥、Token、initData 或播放签名。配置变更与部署由 Railway 审计；本次不打开通知告警。
- 通过 HTTPS API 验证，不运行本地 UI；移动端 P95 仍无有效样本，不能把单次 API 时延写成 P95。

## 视频受理钱包守卫恢复计划（2026-11-17）

- Railway 14:47:29Z 的提交请求在 `video-repository.ts:213` 失败，数据库 cause 为 P0001。确认目标 TEST 后，以只读事务采集函数/约束目录；`reserve_media_plaza_video` 传入视频预扣类型，而当前 `apply_wallet_debit` 只允许 chat/image。11-11 轻量文本专项优先迁移重建函数时覆盖了10-27的视频白名单扩展，账本 CHECK 仍允许视频类型。
- 复用原 reserve/refund、统一钱包 helper、幂等键和日志出口；拒绝重跑10-27旧迁移（会恢复旧发布函数）或覆盖新版钱包函数。新增单文件 forward-fix，只替换当前函数内唯一、已知的 entry_type 守卫，原主体与 bonus-first、所有属性/ACL/OID 保持，未知形状事务拒绝。已修复重放为空操作。
- 数据落位：已有 billing/M 函数，writer 与生命周期不变，无新对象/列/jsonb 键，也不新增跨域引用。5秒锁/30秒语句期限；函数替换与断言同事务，无钱包/流水数据回填、无模型调用。并发 DDL 由 workflow 环境互斥，应用调用沿原钱包行锁和幂等路径；未知执行结果先查账本/目录，不 force_rerun。
- 日志复用提交 HTTP 根、db.supabase 与 `image_plaza.request_failed` 的 request/trace/cause；新增迁移只输出固定守卫失败码，允许类型变化不放开任意错误正文，不打开通知。验证已有真实日志 P0001 关联与后续响应；审批后在 TEST workflow 执行并复核目录。
- 风险评估：涉及钱与迁移，必须新增最小隔离 PostgreSQL/WASM 回归，加载真实钱包/视频 reserve/refund 函数及新迁移；覆盖旧守卫复现、视频预扣/幂等/退款一次、额度不足零扣、聊天专项优先/图片通用策略不变、非法类型、未知守卫拒绝/原子回滚、重放和 ACL。单连接不冒充多连接并发；已有钱包机制未改。
- 发布/恢复：审核最终文件后提交/单独授权推送，再通过 Database Migration 单文件 TEST apply，回读类型守卫和流水约束；不动生产。保留现行分账/退款事实，异常停止受理并采用新 forward-fix，不重跑旧钱包迁移。工程师可复用既有 @image 场景补真实提交失败提示；本轮免本地 UI，单次 HTTP 耗时不作 Android/iOS P95。

## 生产SQL生成（2026-11-18）

用户已要求实施，见production-sql-design.md的复用、落位、可靠性、恢复、日志/性能与专项回归计划；当前任务保持in_progress，生成base/config两文件和测试，不触发生产workflow。

## 生产种子导入授权与等待（2026-11-18）

- 用户已授权生产10批导入，随后选择自己先上线视频版本；当前不触发数据写入/部署，不自动commit/push。
- 已确认生产wbtsfzozlmurljvglhpn健康，视频三表/Stream交付表、UID/播放链接列与service-only RPC已存在；不再沿用先前“生产无表”的审计结论，也不重跑基础迁移。MCP仍仅采集目录结构。
- Railway生产仍为9f21f4a3 / 78159c80-afa0-466b-89dc-3b8c50c809ea，实际源码hydrateWorks仅图片且查不到artifact即报image_plaza_work_shape_invalid；CLOUDFLARE_ACCOUNT_ID为外部暂存变更，不代用户发布。
- 10份种子SQL按原字节复制到唯一迁移源，哈希/行数见production-seed-import-manifest.json；逐文件500（前9份）/487，合计4987，不修改原英文/中文快照、视频UID和私有封面引用。无用户/钱包写入；旧seed的失败回滚/冲突及幂等已隔离验证。
- 用户上线后再核对真实部署SHA含Stream/混合行读取器，确认对应GitHub ref含10文件，逐环境核对ledger/claim/checksum、结构/ACL、素材/封面与容量；再按01→10单文件Database Migration（production显式确认、force_rerun=false）执行，检查每批matched/published与预期一致，失败/未知立即停止。保留原工作流日志审计，不输出prompt/签名/密钥。两份一次性base/config若已存在不得再跑。
