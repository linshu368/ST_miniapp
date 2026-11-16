# 设计与规划审查

## 决策与复用

用户已在完整周末分析和整改方案之后授权“进行优化处理”；按该授权执行冷启动专项，当前规划自审后启动，不包含上线或运营写入。

检索/复用：next.config.mjs 原分流规则；landing-route cookie helper；Providers、EntryShell、early-startup 和启动分段；page-tracker/page-ready 真实时钟；conversation-folders 两个 infinite query；request-concurrency 三槽；api-timing 和 Faro 白名单；现有 launch-url/api/roleplay UI 测试。CharacterGallery 的详情、Growth、Replay 已动态加载，继续复用。shared contracts、后端路由/repository、数据库函数仅作为既有 consumer/契约调研，不修改，因此无 migration/事务/数据库归属设计。

## 入口与脚本

将根路径 307 改为互斥 cookie beforeFiles rewrite，直接返回既有静态目的页。根 Providers 根据 layout segments 解析语义路径，仅认可 chats/characters；这样 SSR 与 hydration 初始 shell 一致，不在渲染期间读取 cookie。EntryShell 输出有限静态 pathname 标记，early-startup 在真实 URL 为 `/` 时读取它再执行既有可见性/ready 校验。

SDK 捕获 initData/startParam、保存合法邀请并清除敏感 URL 参数后，使用 history.replaceState 更新根 URL 为已加载的实际路由，保留非敏感 query/hash 及 Next history 状态。此时才允许 children 接管。无需 router.replace 再取 RSC，无新通用路由 context、不动态化全部页面。直接深链与支付回跳继续由原逻辑处理。若实现验证发现 Next 路径同步不能保证，必须修正设计后继续，不能压制 hydration 错误。

测量从 document 时间零点起，HTML 框架 ready 与内容 ready 分开，不将规范 URL 更新当成一次 SPA。首次 unknown `/` 不应生成虚假成功；最终真实内容仍以 `/chats`/`/characters` 报告。

PagePerfTracker 显式接收 Providers 已解析的真实路径，在 SDK 就绪后就挂载，不等待 History fallback 完成；业务组件仍等待规范路径。这样受限 History 环境停在框架时也有真实页面 watchdog，不因 root 未登记而漏掉卡住。规范化前后语义路径相同，不重置时钟。

## 请求与观测

复杂度核查要求同步收紧触及的存量超长代码：将 grafana 的既有有限事件/字段表原样移到 grafana-schema.ts，使 exporter 文件低于 500 行；将 HTML native transport 提取为独立自包含函数并作为参数序列化，使启动探测函数低于120行。没有第二套白名单或桥接实现，原有测试继续约束两者。

可见列表/分组 pageParam=0 显式 critical，其后分页 normal；enabled 继续由页面选择控制。保留信号、deadline、取消、有限 GET 重试与总并发上限。避免把所有 conversations 全局归为 critical，特别是后台/展开子列表。groups 分类在动态详情匹配前独立处理，纳入有限 allowlist；发布前后的 detail 统计不能直接混比。

## 可靠性、最小方案与恢复

- 无新增外部调用、重试、定时刷新、持久缓存或任务队列；现有总 deadline/有限重试适用。只改变请求顺序，不加并发容量。
- 无写入契约/幂等/事务/补偿变动；身份与计费不缓存、不重放。cookie 仍是无身份的 landing hint，错误值回大厅。
- 无跨用户数据：rewrite 只选公开静态 shell，私有数据仍在鉴权后的 React Query 中读取；禁止 cookie 维度私有响应缓存。
- 失败：JS/SDK/bridge 不可用沿用 shell 与原 fallback；存储拒绝沿用原 catch；history 更新失败须保留可用页面并有有限恢复方案，不记录原 URL；网络/API 错误保留原重试入口。
- 无新依赖；不做 Sentry 替换、Service Worker、全站 dynamic SSR、固定用户缓存或无证据的大包拆分。构建审计记录首屏 JS，已有异步能力不重复实现。
- 灰度按 release 分别比较 Android/iOS。出现 hydration、错页、身份/支付异常、错误率或 P95 回退即停止推广，回滚本次前端版本；无数据库/后端发布顺序。部署由后续发布流程负责，本轮不自动发布。

## 验证与性能

详见 implement/task 与 task.json。基线来自 11/14–15 生产；iOS /chats N81 不足，延长观察。发布后至少 24h、每平台/路径成功 N≥100，低流量延长48–72h；同时看 started/failed/left/stall，不能只看成功者。不同阶段 P95 不相减/相加，本地环境只能证明机制与回归，不能证明线上4秒目标。

规划自审：覆盖复用、超时/有限重试、并发、无写入事务理由、降级、容量、观测、兼容、回滚、失败路径和消费者；本任务无需新增测试文件，扩展现有测试锁定启动身份/路由与优先级风险。
