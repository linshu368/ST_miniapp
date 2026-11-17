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
