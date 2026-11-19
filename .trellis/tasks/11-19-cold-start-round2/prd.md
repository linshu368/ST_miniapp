# 冷启动端到端瓶颈与关键链整改

## 目标与用户价值

冷启动端到端瓶颈与关键链整改，使用户获得更稳定、更快的真实可用页面/任务结果；不是仅降低告警或调整统计。属于[总任务](../11-19-mobile-performance-round2/prd.md)。

## 背景和证据

冻结窗口2026-11-17 15:10:52—2026-11-19 15:10:52；[安全证据](../11-19-mobile-performance-round2/research/evidence.md)。代表基线为/chats page.launch；/characters Android9031.28/N278、iOS6560.3/N80。目标4000是改善目标，长期2秒目标保留；API范围为空，因此API两值null，不新增服务端接口。

## 需求

- C1 对真实根入口、文档、脚本、Providers、SDK、shell与content-ready分段核验；分别解释至少3个Android与3个iOS慢样本，保留异常样本而不相加独立P95。
- C2 复用已上线rewrite、HTML early-ready、critical槽和入口分波；不重复做同一优化。只有同次证据和构建依赖证明阻塞的可选依赖才延后，核心列表不拆成串行chunk。
- C3 现网响应头探测成功并确认公开HTML与身份隔离后，才考虑具体缓存/预加载调整；当前无CDN头证据，不能先改公共缓存策略。
- C4 保留邀请/支付回流、SDK初始化、历史URL同步、低端WebView、HTML壳与完整内容计时；不提前ready、不用shell指标替代page.launch。

## 验收标准

- [ ] AC1 Android/iOS /chats与/characters冷打开目标≤4000ms；按新release至少48h、每route/platform N≥100后评估；iOS不足延长72h，不宣布已达成。
- [x] AC2 根入口无额外307、无身份参数丢失或hydration错误；阻塞JS时原HTML壳与native-ready安全退化不变。
- [x] AC3 若关键等待主要发生在请求发出之前且没有可控制应用原因，提交诊断/最小补强，保留未达目标事实，不改业务掩盖宿主/网络问题。
- [x] 适用的既有测试/typecheck/lint/build通过，必要风险回归按implement执行；失败、低样本和无法运行项真实记录。

## 不在范围

无自动生产发布/数据库操作/运营配置写入；不重做UX或改变权限、计费、审核、默认统计周期；不建立通用缓存/调度/队列框架。技术未证实项按design停止条件处理。

## Local delivery status

User approved implementation on 2026-11-19. Local code and automated verification are complete; see [verification.md](verification.md). Production P95, real Telegram and Railway termination acceptance remain pending. Task is in review; no commit or deployment performed.
