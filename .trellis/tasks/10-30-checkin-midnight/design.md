# 设计

## 复用和最小方案
已检索MiniappWalletRepository.getDailyCheckinStatus、claim_daily_checkin、quoteDailyCheckinReward、wallet DTO、payment hooks、useRefetchOnForeground、profile fixture及VIP SQL harness。复用接口、锁和grant_bonus_credits；不加表、列、cron或周期轮询。shared wallet helper仅计算下一北京时间午夜，供状态接口和fixture复用。

## 归属和可靠性
只替换miniapp_features.claim_daily_checkin(uuid)内资格及返回时间表达式，保留当前函数奖励配置、事务、owner/ACL/search_path及advisory lock。miniapp_features拥有签到事实和资格，billing.grant_bonus_credits是唯一余额/流水写入方，app_core提供用户/配置，billing提供会员事实。无新对象或跨域写入口。

取得会员锁后重新采集clock_timestamp，避免跨午夜等待锁时用旧时间。同日拒绝保持与发奖同事务。迁移精确单次锚点替换当前函数并兼容CRLF，未知shape失败；5s锁/30s语句预算，无业务行回填、全表扫描或新容量。保持权限，不扩大入口。

前端按next_claim_at只安排一次刷新；以服务端结果决定资格和金额，失败保留旧状态，靠现有返回前台/重试恢复。沿用请求超时和错误日志，无新补偿、重试、限流或遥测系统。

## 发布与恢复
本地PG验证→经授权TEST workflow→生产迁移→Backend→Frontend。旧Backend只会保守等待24h。历史不回填、不重发。恢复用forward-fix同步RPC与Backend为滚动24h，已领余额与流水保留。锚点/权限/并发检查失败即停止。
