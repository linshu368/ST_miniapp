# 影像创作首屏与视频交付恢复优化

## 目标与用户价值

影像创作首屏与视频交付恢复优化，使用户获得更稳定、更快的真实可用页面/任务结果；不是仅降低告警或调整统计。属于[总任务](../11-19-mobile-performance-round2/prd.md)。

## 背景和证据

冻结窗口2026-11-17 15:10:52—2026-11-19 15:10:52；[安全证据](../11-19-mobile-performance-round2/research/evidence.md)。/create导航Android5222.045/N22、iOS2270.4/N35；工作室无导航样本，挂载Android1416.425/N66、iOS561.4/N65不能代替导航。feed API Android1850.795/N124、iOS1532/N41，queue仅9.61/7ms，不宣称队列就是当前慢因。昨晚Wan第二任务发布中断后等5分钟租约为单任务证据。

## 需求

- M1 核对feed当前已默认critical（client.ts:179），不重复修首屏优先级；改为可见首页critical、分页normal、空闲预取background，保留同一query key/queryFn与去重，取消不会多发真实生成。
- M2 同一delivery轮次复用已取回Buffer，最多4块，连续起块达到20秒后继续原任务；不新增跨任务媒体缓存或本地持久化。实施复核将20秒明确为起块预算：取源/非幂等创建/在途分块沿原15/60/120秒超时并接入shutdown signal，避免剩余短预算制造未知创建；只读编码采用20秒signal。每块checkpoint并核验fence，不支持取消的未知传输未结算时不能释放租约。
- M3 正常SIGTERM先停止claim再有界drain，已知安全上传阶段在网络已终止后用现有lease-token checkpoint释放；creating/unknown/publish不确定保留原对账/租约保护。不得简单缩短5分钟租约。
- M4 页面ready、封面、视频首帧、上游排队/生成、Stream上传/转码/发布各自统计，401匿名隐私探测为预期，不改签名或访问权限。

## 验收标准

- [ ] AC1 feed已有缓存/预取进行中/分页/筛选均不重复首页请求、不串游标；后台预取不抢critical。/create页面新release目标≤2000ms但当前双方N<100，先补量。
- [x] AC2 20MiB/4块固定虚构视频同一轮只取源一次；每块持久checkpoint，lease丢失立即停止，不重发不明create或publish、不双扣/双发布。
- [ ] AC3 正常停止上传可在30秒内安全交接；强杀/创建未知/发布未知保留租约和既有恢复，不承诺所有崩溃都可即时接管。
- [x] AC4 上游生成耗时不算应用优化收益；成功/失败/退款/未知结果与原计费事实一致。
- [x] 适用的既有测试/typecheck/lint/build通过，必要风险回归按implement执行；失败、低样本和无法运行项真实记录。

## 不在范围

无自动生产发布/数据库操作/运营配置写入；不重做UX或改变权限、计费、审核、默认统计周期；不建立通用缓存/调度/队列框架。技术未证实项按design停止条件处理。

## Local delivery status

User approved implementation on 2026-11-19. Local code and automated verification are complete; see [verification.md](verification.md). Production P95, real Telegram and Railway termination acceptance remain pending. Task is in review; no commit or deployment performed.
