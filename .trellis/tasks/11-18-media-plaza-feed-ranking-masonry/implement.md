# 执行与验证计划

状态：已完成本地实现与验证；结果见verification.md，远端与真机验收仍待执行。

## 1. 实施顺序

1. 审核通过后运行task.py start，按trellis-before-dev重新核对受影响规范及最新工作区。确认没有其他人同时修改目标文件。
2. Shared先扩展推荐v2 opaque cursor schema，保留latest v1和旧schema的解析/拒绝边界；只暴露API需要的语义，不导出DB行类型。补现有shared契约回归。
3. 编写唯一前向SQL migration：派生排名表、原子rebuild、有界recommended read与最小权限。按design §3实现relative档位、revision和锁；同PR更新registry。用真实本地SQL引擎验证后才接Backend。
4. Backend repository接单次推荐RPC，保留latest和hydrate，过滤/游标与ORDER BY对齐；feed完成日志补media/版本/计数，拒绝/超时保留真实终态。导入脚本成功后共用排名重建入口；提供明确环境的预览/执行维护命令，不自动运行远端。
5. Frontend query key隔离v2，INVALID_CURSOR清链恢复首屏一次，恢复再次失败时显示错误而不是无限循环。组件继续只通过lib/api hooks读服务器数据。
6. 拆分/create的列表职责，最短列稳定追加、宽度/信息区估算、双sentinel单飞；保留render budget、critical preview、eager原始索引、下拉刷新、筛选与回流锚点。
7. 广场专用视频观测器抽离，覆盖真实帧、prepare、seek、stall和完整终态；改活动播放器预加载/释放与换签generation隔离。沿用HLS/ABR、Apple分支和现有播放接口。
8. 扩展Sentry/Faro名称/有限维度/净化，细分广场feed/detail/playback API分组，遥测上传排除产品请求聚合。同一观测结果镜像两个出口，保持已有上报预算。
9. 扩展现有@image fixture/场景，覆盖静态三页混排与单类型、横竖比失衡、慢/坏封面、旧游标、回流、视频真实fixture播放。更新运行文档/README/架构及相关spec，明确本地候选与未远端执行状态。
10. 执行trellis-check全范围复核、适用验证；必要时修复并仅复跑受影响检查。产出验证记录、发布/恢复步骤和真实窗口待办。

## 2. 测试必要性与风险决定

本任务涉及推荐契约、数据库派生数据/锁、旧游标恢复、异步视频回调；需要回归锁定，优先扩展已有repository.list-works.test.ts、shared API测试、frontend API/perf测试和ui-tests/tests/image.spec.ts。真实SQL行为须有可重复本地harness，不可只mock RPC。

只有已有文件无法合理承载时才新增最小的排名SQL、瀑布流或视频观测回归文件；审核本规划意味着确认这些具体风险的必要回归。无新增通用测试框架/依赖；虚构数据不包含秘密或生产业务行。

## 3. 可执行验证

基础命令（受影响测试的精确文件名在实现落地后记录到verification.md）：

```powershell
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-18-media-plaza-feed-ranking-masonry
python -c "import sys,json,pathlib; sys.path.insert(0,'.trellis/scripts'); from mobile_performance_gate import validate_mobile_performance; validate_mobile_performance(json.loads(pathlib.Path('.trellis/tasks/11-18-media-plaza-feed-ranking-masonry/task.json').read_text(encoding='utf-8'))); print('mobile_performance: passed')"
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/features/image-plaza src/routes/image-plaza.test.ts src/routes/video-plaza-playback.test.ts
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm lint:complexity
pnpm lint:backend-logging
pnpm lint:migrations
pnpm lint:db-contract
pnpm -r typecheck
pnpm --filter @miniapp/frontend build
pnpm test:ui:fixtures
pnpm test:ui --grep @image
```

shared/backend没有build脚本，两包以现有tests/typecheck验证；frontend执行生产build。现有复杂度基线里的超长文件/函数改到时拆小，收紧基线运行 `node scripts/complexity-budget.mjs update`，不能自动豁免新增超标。

本地SQL命令复用可用的PostgreSQL/PGlite harness，实施时先发现现有引擎位置，再将实际可执行入口、版本和结果写入verification.md。不能使用未确认目标的远端数据库代替本地验证；测试环境/权限或引擎不可用时记录阻塞和剩余风险，不宣称通过。

## 4. 失败路径与consumer检查

- 排名：1万/10万候选、100001拒绝、0热度/缺热度/缺模型、同热度、正热度模型样本悬殊、空目录、无视频/无图片；全局均衡和单类型剪枝次序；重建同序与新revision。
- SQL安全/一致性：匿名/普通登录不可读写，service可用；固定search_path、无PUBLIC execute；共享读锁与排他重建；锁/语句超时；重建失败全回滚，当前目录仍可读；大页/注入/非法cursor参数拒绝。
- 游标：bigint字符串、错误sort/filter/media/revision、旧v1推荐、latest v1继续、正好20/21条、liked跨到zero；静态连续翻页无遗漏；实时取消点赞/新分享仅验证现有动态feed与ID去重，不扩大为冻结快照。
- 前端consumer：shared tests和全仓typecheck；缓存旧第一页不得接新v2后页；INVALID_CURSOR只恢复一次；双sentinel同帧触发、慢网/断网/切filter、刷新与返回详情。
- 视频：无rVFC、paused seek、后台/离页、资源加载失败、一次换签失败/并发错误、旧源迟到帧、重复playing/waiting；真实帧前不成功，失败不写0ms，watchdog不取消真实播放。
- 观测：Sentry与Faro同一结果/定义；关闭遥测、出口抛错、429/超时不改变业务；有限维度/签名URL与身份净化；后端Pino安全投影、一次HTTP终态、request/trace响应头。
- 本地UI：320/390宽度、混合横/竖/方比例至少三页、模型均衡/有赞前置/最新分享时间、短列无整屏空白、append不移动旧卡、0清单/分片请求、原有生成/分享/用同款不回归。

## 5. 人工与发布后验收

真实Android/iOS Telegram分别验证封面、详情、native controls、首次播放、未缓存seek、后台回前台、换签、离页停止网络；受控参考网络10Mbps/100ms下复测首帧/seek，弱网另记。fixture不能替代供应商、系统媒体引擎或实际P95。

先TEST再production、单文件迁移、核对shape/ACL/规模/EXPLAIN/排名覆盖与回滚。只在已确认连接目标的只读结构采集范围使用Supabase MCP，不读取业务行或导出提交Git。实际生产执行/部署另行授权，本轮不自动操作。

发布前后24h同环境/平台/定义窗口，N<100延长72h；分release、媒体、排序、cache及measurement，比较P95和error/stall/left。当前基线null；新增指标先建首窗，后续版本再比较。不自动创建远端仪表盘/告警或发送消息。

## 6. 恢复与交付

回退消费者可重新使用未修改的历史initial_feed_order，保留新派生表/函数便于forward-fix；资金/作品/资产事实不回滚。列出最终改动、验证与未覆盖真机场景供人工审核；不stage/commit/push或自动归档。
