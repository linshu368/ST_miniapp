# 执行计划（用户已审核主路径）

## 顺序

1. 核验真实网络能力、实时Grafana数据源、日志留存/分页。记录各平台TAO/Range条目/迟到/未知；能力不足时缩小承诺交用户判断，不擅自建代理。
2. shared先扩v1兼容/v2字段和上限，再扩现有前端tracker/media/observer/API；同一时钟和成功规则，缺失/逆序不伪造。
3. 归属/目标shape核验后写单migration：分析表、原子合并、只读投影/权限、有界清理。复用getDomainDb和repository，短超时/有限并发；SQL已实现并通过本地隔离验证，远端按单文件门禁执行。
4. 新看板与限定历史导入器：先dry-run证明全窗/分页/去重，复用DS_POSTGRES，不改经营看板/重cron。旧/新版本和环境分开。
5. 本地验证→TEST→独立生产确认。Backend先Frontend，最后看板/受控导入；记录环境/release/N/覆盖/容量/GAP。

## 失败/consumer验收矩阵

- 状态机：首帧早/晚于playing，loadeddata缺失/逆序、40s等待、slow+final去重、暂停/拒绝、后台/退出、重试/换集、旧src/Promise迟到。
- 网络：TAO隐藏/不支持/无条目、0与缺失、缓存/连接复用、poster排除、同URL多请求、Range不逐条可见、在途/迟到、切源隔离、16条截断、URL不泄露。
- 送达/持久化：start/slow/final/network乱序、重复/冲突、DB超时已提交、429/503/离线/强关不影响播放；accepted与落表语义一致。
- SQL：真实本地PG验证事务/并发原子合并、唯一键、RLS/SELECT/EXECUTE、清理分批/预算/关闭；生产查询计划/容量独立核验。
- 统计：合成数据核对分母、NULL/0、删失/未知、legacy/start缺失、直方边界、去重、P95不相加、cohort成熟窗口、明细采样不影响summary。
- Grafana：以真实reader逐面板检查查询和渲染，单SQL5s内，不扩连接。

## 实施后的命令

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/backend test
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm lint:imports
pnpm lint:migrations
pnpm -r --if-present build
```

优先扩既有测试；SQL回归脚本在规划审核后补并记录命令，本轮不创建测试文件。若批准固定UI验收，扩packages/ui-tests短剧分组，不新造一次性mock后端。

## 人工/上线验收与恢复

指定TEST视频分别制造API慢、媒体首响应慢、metadata后数据慢、play拒绝/恢复、切集/换剧/后台；从Grafana找到单次观察和对应日志，与真机网络核对。真实iOS/Android Telegram验收能力；fixture不能证明供应商网络/真实解码/Range。

生产少量观察/历史导入仅在执行阶段明确授权后进行。本地产品测试与构建已执行；远端迁移/部署尚未执行。超过design停止条件，关新持久化/明细，保留旧日志；关清理job、先回Frontend再兼容退Backend，保留表，用独立forward-fix修SQL。
