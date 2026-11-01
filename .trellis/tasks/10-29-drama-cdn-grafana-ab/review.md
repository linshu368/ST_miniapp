# 本地实现审核摘要

## 结果

现有工程短剧看板追加独立CDN A/B区，包含终态/未知归属、5秒达标率和有效分母、成功P50/P95、成功有效N、成功耗时分布、加权卡顿及窗口N、原桶到实际节点/原因。两个桶同时显示，默认排除retry。旧SQL写入未恢复，原分流、签名、播放、重试和媒体超时不变。

核心口径：按单次原始elapsedMs与首帧+playing判断<=5000ms；final携带原子分类，后台/缺证据单列。现有快日志是否抽样不影响Faro全量投影；slow/network不重复计数。窗口身份随src快照，不被下一次取址污染。原Bunny桶回退Supabase仍属Bunny分组。

未知归属/未送达不补成功，播放次数不当人数，不提供用户级20/80核验或显著性。缓存/首帧方式筛选得到的是条件子集，不可据此外推所有启动；正式对比优先使用全部，结合未知/失败构成。

## 文件范围

- 产品源码3个：packages/frontend/src/lib/perf/grafana.ts、drama-observer.ts、drama-media.ts。
- 既有测试3个：同目录grafana.test.ts、drama-observer.test.ts、drama-media.test.ts。
- 看板候选：docs/grafana/st-engineering-drama.json。
- 固定本地链路验算：ops/observability/local-test/faro-loki.mjs。
- 说明/spec3个：docs/grafana/engineering-performance.md、docs/drama-playback-timing.md、.trellis/spec/frontend/app/testing-quality-and-deployment.md。
- 本任务全部规划、验证、模块更新候选和离线看板增量操作。module-updates.json须随最终审核，不提前apply/归档。

以上均为拟提交范围，当前未stage/commit。建议单个完整变更单元`feat: add drama CDN experiment comparison`；若批准提交，必须核对最终digest，推送仍为独立操作。

## 验证与风险

具体执行证据见validation.md。局部样本、查询无语法错误、本地合成通过都不能代替真实Cloud新字段送达、Telegram真机或生产效果。

源码19个原面板与Cloud当前24个原面板不同：不得用候选整张覆盖线上。dashboard-operations.json准备了追加变量/面板的操作，基于本次只读快照排在y=146；发布前重读UID、核对无200–208冲突并重新计算底部位置。需要回退时仅移除本次追加对象/回退Frontend版本，不删其他数据。

线上看板写入、应用部署与最终提交/推送没有在本次实现授权中一并批准；保持当前本地可审核状态。

## 规范同步判断

新增字段/口径写入现有Frontend质量spec，模块知识提供与当前原文hash绑定的更新候选；不修改通用agent流程或包索引结构，因此无需同步无关workflow/agent文案。不增加长期通用实验框架，也不因本任务创建backlog。
