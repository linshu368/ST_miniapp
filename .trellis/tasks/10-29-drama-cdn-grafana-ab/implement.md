# 执行计划（已获用户批准）

## 主路径与工作量

约4步，3个产品源码文件、1份看板JSON，扩展3个既有单测文件和1个既有合成脚本，另同步约2–5份相关说明/spec。第一轮只交付本地可验证实现和看板候选，不承诺生产已生效。

1. 用户审核本PRD/design/task后，确认module impact和context，再`task.py start`；在隔离分支实施，不接触主目录脏文件。
2. 扩展grafana白名单和observer的已有final/measurement投影；定义单条terminal上的5秒分类；媒体窗口绑定每src delivery快照。不修改业务和shared公开契约。
3. 扩展现有测试与合成验证，追加版本化看板CDN区及实验筛选；验证所有分子/分母/窗口采用相同过滤和合法性，未知总体不冒充实验覆盖率。
4. 同步docs/spec/module更新候选，输出最终diff/校验摘要与部署/看板操作清单；提交、推送、合并、应用部署、线上看板更新各按当前授权另行处理。

## 适用验证

```bash
pnpm --filter @miniapp/frontend test -- src/lib/perf/grafana.test.ts src/lib/perf/drama-observer.test.ts src/lib/perf/drama-media.test.ts src/lib/perf/drama-timing.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
node ops/observability/local-test/faro-loki.mjs
```

工作树无依赖时先按锁文件安装；Docker不可用则明确本地Loki验证未完成，不能以纯字符串匹配代替真实LogQL执行。若实现确实扩展shared合同，必须回到规划更新范围，然后运行shared测试、`pnpm -r typecheck`及适用workspace build；本方案预期不触发。

格式与结构：版本化JSON解析、Prettier涉及文件检查、task.py validate、module_knowledge检查。生产采集与图表发布前重读最新线上UID，避免覆盖首张画面等并行更新。

## 验收用例

- 两桶快/慢成功，5000ms精确边界；outcome与budget同条事件，没有slow/network重复终态。
- 失败、自动播放被拒绝、离页/换剧和后台分别可辨；playing缺时长/帧证据不冒充达标。
- 同一用户多次播放不标为多用户；started与terminal不作严格覆盖比例。
- delivery缺失/旧版本不落入Supabase；新投影未知与历史无标签分开。
- 原Bunny桶实际Supabase/disabled，分组不改；旧源flush不借新源身份。
- 重试不覆盖前次失败，主视图默认排除retry；首页文档入口耗时不混入单次启动P95。
- 质量窗口暂停/seek/后台排除、未恢复等待保留，成对时长加权；分母0/空桶无数据。
- beforeSend二次白名单、非法属性、实验ID限额、secret/URL/身份剔除；关闭/队列满/发送异常不影响播放。
- query中的事件字段用 `event_data_*`，measurement 用 `context_*`；keep有限维度后unwrap，迟到network不进入总分母。

## 人工与线上门禁

已有@drama虚构流程可复用作播放器行为回归，需补两桶/disabled/unknown遥测断言时扩展现有fixture，不新建后端。真实Telegram与真实CDN效果单独验证。

实施完成后准备：本地测试结果、Cloud TEST新字段回读、查询有效N、实际release、线上看板当前版本/拟增量、回滚方案。未经相应授权不改Production配置、不发布、不以当前历史日志补造对照样本。

## 回滚点

- 任一安全/行为隔离测试失败：不发布，修复当前最小范围。
- 本地查询失败：只调整新增查询，不重写无关现有面板。
- 实际发现必须改Backend/用户身份/公开契约才能满足指标：暂停当前实施，回规划说明范围变化。
- 已发布后可回退前端版本和新增看板区；不删数据、不改分流key/比例、不恢复SQL。
