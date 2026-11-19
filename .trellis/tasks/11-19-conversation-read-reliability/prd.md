# 聊天详情取消分类与会话读取可靠性

## 目标与用户价值

聊天详情取消分类与会话读取可靠性，使用户获得更稳定、更快的真实可用页面/任务结果；不是仅降低告警或调整统计。属于[总任务](../11-19-mobile-performance-round2/prd.md)。

## 背景和证据

冻结窗口2026-11-17 15:10:52—2026-11-19 15:10:52；[安全证据](../11-19-mobile-performance-round2/research/evidence.md)。导航代表/chat/:id Android3866/N1301、iOS3797.6/N168。API代表conversation_detail Android2042.6/N13117、iOS1963.7/N2002；groups iOS2595.95/N258，list iOS2236/N521另验。Sentry CC82只是问题规模，不代表82个已证明正常取消。

## 需求

- H1 仅在已确认客户端连接关闭且本路controller触发abort时，按取消/中断结束读取，不重复throw到通用500/Sentry；真实SDK deadline、数据库和身份错误继续保留。
- H2 复用detail现有identity/owner/settings/recover/opening/page分段、60秒身份singleflight和summary250ms。不得对已存在缓存重复建状态源，不因正常取消重试读写或结束后台生成。
- H3 Sentry CR26次身份失败与F4单次循环更新要在现版本复现并核对trace；保留未知原因，不把它们全部按AbortError过滤。
- H4 顶级慢请求包括已退役聊天配图链路（90/6J）；确认9b0a0ee4及后继已无该请求，避免复活已删除功能。

## 验收标准

- [ ] AC1 同route/platform新release导航目标≤2000ms；API总等待目标≤2000ms，低样本/混合release分开。
- [x] AC2 客户端主动离页取消不再生成假500；真实5秒身份超时、ownership拒绝、读取异常仍各有一次可关联终态和原公开错误契约。
- [x] AC3 同会话取消/恢复/新建/切换、真实生成断连继续后台完成、仅一次结算行为不回退；F4不能复现则保留调查结果，不能宣称已修。
- [x] 适用的既有测试/typecheck/lint/build通过，必要风险回归按implement执行；失败、低样本和无法运行项真实记录。

## 不在范围

无自动生产发布/数据库操作/运营配置写入；不重做UX或改变权限、计费、审核、默认统计周期；不建立通用缓存/调度/队列框架。技术未证实项按design停止条件处理。

## Local delivery status

User approved implementation on 2026-11-19. Local code and automated verification are complete; see [verification.md](verification.md). Production P95, real Telegram and Railway termination acceptance remain pending. Task is in review; no commit or deployment performed.
