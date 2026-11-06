# 执行任务分解

## 规划门禁

- [x] 阅读 README、架构、frontend/backend 相关规范与跨层指南
- [x] 记录 Sentry 固定基线、当前 Grafana 和 Railway 生产证据
- [x] 完成组件/hooks/helpers/contracts/repositories/CDN 复用调研
- [x] 完成可靠性、最小充分、演进恢复与可验证性设计
- [x] 用户确认开始实施，视为评审通过 `prd.md`、`design.md`、`implement.md`
- [x] 评审通过后执行 `task.py start`

## T1 指标口径

- [x] 为三页定义关键视觉 settled 事件并保留历史指标
- [x] 补 cache、document/SPA 等低基数维度；provider 维度等待 Bunny 阶段
- [x] 固化 Grafana 页面、freshness、API stage、终态率和样本量面板源文件
- [ ] 增加 release annotation，并验证查询不会跨 release/cohort 混算
- [x] 测试验证无敏感字段且 loaded/error/absent outcome 完整
- [ ] 收集基线样本并锁定 dashboard 查询

## T2 首页与短剧目录

- [x] 增加专用 drama catalog 版本化有限缓存
- [x] 接入 `/`、`/dramas` 的 React Query initial data/freshness
- [x] 覆盖损坏、过期、刷新失败和离页路径；删改由 fresh response 校准
- [ ] 对比首屏、fresh、API attempt 和 page-left

## T3 角色卡调度

- [x] 将背景 freshness 与关键头像竞争隔离
- [ ] TEST 对比 BFF 与直连 Railway
- [ ] 只保留满足收益和兼容门禁的单一路径

## T4 图片 CDN

- [x] 短剧卡片和首页海报采用有限 Supabase transform variants
- [x] 校准 `srcset/sizes/eager/priority`
- [ ] 验证 HIT/MISS、字节、TTFB、decode、quota 和错误率
- [ ] 记录上传端 immutable/versioned path 后续项

## T5 视频 CDN

- [ ] TEST PR 525 同对象 A/B 达到样本量
- [ ] 评审性能、Range、安全和成本证据
- [ ] 环境化 Bunny provider/origin/namespace 配置
- [ ] 生产 5%→25%→100% 灰度或按停止条件终止
- [ ] 演练关闭 flag 和新请求恢复 Supabase

## T6 条件式 bundle

- [x] 量化 route chunk；long task 等待生产 release 数据
- [ ] 达到阈值时仅拆非默认 tab，否则记录“不实施”

## T7 验收

- [x] 运行受影响包 typecheck/test/lint/build
- [x] 扩展并运行 `@drama`、`@roleplay` 既有 UI 流程
- [ ] 完成 Telegram 真机冷/暖缓存与弱网验收
- [ ] 三页分别满足 PRD 4.2 的 Grafana 24 小时 p95、样本量和失败率门禁
- [ ] 7 天滚动 p95 无明显回弹，冷缓存 cohort 不被暖缓存总体掩盖
- [ ] 记录剩余风险、回滚状态和是否进入下一阶段
