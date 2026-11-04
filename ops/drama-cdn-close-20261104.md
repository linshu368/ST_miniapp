# Bunny 本轮实验结果与生产关流

结论：**本轮未观察到明确增益**。该结论仅限本轮收到的描述性样本，不能推断 Bunny 在所有场景下无效。

## 实验与统计边界

- 实验 ID：`drama-bunny-prod-20261029-v1`；稳定用户分桶约 Bunny 20% / Supabase 80%。
- 正式开流起点：`2026-10-29T13:53:42.993Z`（北京时间 10 月 29 日 21:53:42.993），以启用部署成功且旧禁用部署移除为依据。
- 本报告主统计为半开窗口 `[2026-10-29T13:53:42.993Z, 2026-11-04T02:59:06.000Z)`，北京时间截至 11 月 4 日 10:59:06。主统计截止与实际关流时间分开记录；期间尾段另存，不冒充已计入主统计。
- 首次开流版本 `6e5068f350277d05b1eceaba229f762c09b38ca4`；关流前最近核对的生产版本 `26da44cc74420caf3642c33bcb4b4752eff6132c`。全部实际出现的前/后端 release 及分版本结果保存在 summary JSON；全周期存在多版本和播放策略演进，不是同一版本冻结的因果对照。
- 来源：Railway production / stminiapp 的 `@event:drama.frontend_timing`，跨部署服务级查询。38 个未饱和窗口，11,530 条原始日志，4,449 个起播/seek 观察；查询窗口、条数、首尾时间和边界去重方法均留存。
- 人数：以服务端本实验 HMAC 去重码统计已收到播放/seek 遥测的独立用户，Bunny **45**、Supabase **144**。不是全站访问人数；不以播放次数或会话数代替人数。未导出明文用户身份。

## 两组结果

下列起播排除 entry=retry；P95 为已收 final、outcome=playing、具备 frame_method 和真实 first_frame/playing 标记的成功样本，按线性插值 quantile 计算，单位毫秒。优先展示实际 provider 与原分组相符的样本，未知路径不强行归为 Supabase。

- Bunny：起播共 491 次，实际 Bunny 路径已知 429 次；可测首帧成功 **176** 次，P95 **8,421.975ms**。全桶失败 129（126 自动播放受限、3 error），退出/换片/后台 177，缺 final 9，缺 start 9，帧未验证 1。
- Supabase：起播共 1,969 次，实际 Supabase 路径已知 1,700 次；路径已知的可测首帧成功 **841** 次，P95 **7,710.400ms**。全桶失败 454（444 自动播放受限、10 error），退出/换片/后台 648，缺 final 23，缺 start 16。
- 未知实际路径：Bunny 62 次、Supabase 269 次；其中 Supabase 桶另有 3 个具备首帧标记但 delivery 未知的成功观察，单列不当作 Supabase 路径成功。若只按原桶合并这 3 次，Supabase 成功数 844、P95 7,964.325ms；该值不能解释为已确认 Supabase 路径性能。
- 未缓冲快进 `seek.buffered=no`：Bunny 145 次、18 人，其中真实目标帧成功 **89** 次、P95 **6,296.480ms**，56 次 switched；Supabase 642 次、63 人，其中成功 **441** 次、P95 **4,767ms**，193 次退出/切换/后台、4 次 waiting 缺 final、4 次 unverified。收到 seeked 不单独算成功。
- 可用平台分布（原桶、可包含 delivery 未知；跨平台人数不可相加）：Bunny 起播 Android 386 次/38 人、iOS 71 次/7 人、desktop 34 次/1 人；Supabase 起播 Android 1,542 次/114 人、iOS 398 次/27 人、desktop 29 次/7 人。未缓冲 seek 的 Bunny 为 Android 136 次、iOS 8 次、desktop 1 次；Supabase 为 Android 590 次、iOS 49 次、desktop 3 次。Bunny iOS 未缓冲成功仅 5 次，不能据其局部 P95 推断稳定收益。
- 缓冲内 seek、未知状态、平台和分版本结果见 JSON。起播后重试独立保留：Bunny 2 次/1 人、2 成功；Supabase 6 次/5 人、3 成功、2 error、1 left。原失败没有被重试成功覆盖。
- 已知路径中未见 Bunny 原分组回退 Supabase 的观察；未知 delivery 不算“无回退”。autoplay_blocked 与退出不能推断为 CDN 请求失败。关流后的正常 disabled 路径不纳入原实验效果。

## 统计限制与查询依据

按 type + observation_id 聚合 start/slow/final/network，边界重叠日志按完整接收时间/type/id/phase 去重；冲突终态不挑最快成功。本次所选指标未发现冲突。缺报/离线、未知路径、缺首帧与缺 final 均不补成成功。未收口的 elapsed 只是下界。

用户数 45/144 仅为实际收到遥测的人数；用户观看次数不同，同一用户多次播放不构成独立实验单位。样本跨多 release、网络/缓存冷热不可控，冷/热不可观测不删样本；不做显著性或普适有效性判断。服务端完整查询只能证明可访问保留日志已按窗口取完，不能证明所有客户端均成功送达，也不能排除平台服务级历史覆盖范围限制。

- [汇总与平台/版本分层](../.trellis/tasks/10-29-drama-cdn-rollout/research/closure-20261104-summary.json)
- [逐窗口查询依据](../.trellis/tasks/10-29-drama-cdn-rollout/research/closure-20261104-queries.json)
- [可重复统计脚本](../.trellis/tasks/10-29-drama-cdn-rollout/research/closure-20261104-analysis.mjs)：使用 `node .trellis/tasks/10-29-drama-cdn-rollout/research/closure-20261104-analysis.mjs /private/tmp/st-bunny-close-20261103`，只读本机保留样本、不连接生产。已重新计算 4,449 个观察，并验证所有 group/provider/platform/release 汇总与保存结果完全一致。
- [执行范围与生产目标](../.trellis/tasks/10-29-drama-cdn-rollout/closure-20261104.md)
- 本机私有明细：`/private/tmp/st-bunny-close-20261103/telemetry-*.ndjson`，仅允许列表字段与实验 HMAC，权限 0600；不提交 Git，不含密钥、签名 URL 或明文用户身份。

## 关闭与验收状态

本报告主统计于修改开关前保存。随后尾段 `[2026-11-04T02:59:06Z, 2026-11-04T03:01:30.941Z)` 用同一服务级过滤查询，返回 0 条，未饱和。因此完整开流区间截至实际关闭点的已收到样本与主统计一致。部署过渡区间另有新旧副本交接，不将未观察到的请求补成结果。

生产关流于 **2026-11-04T03:01:30.941Z（北京时间 11 月 4 日 11:01:30.941）** 生效：新部署 `911cb481-b57b-4aa7-83d7-9386d266c632` 于 03:01:27.830Z SUCCESS，原启用部署 `fbad46dc-0dbb-444d-9cfb-070affa39c8a` 于 03:01:30.941Z REMOVED；1/1 副本 running，无 pending work。相同 SHA `26da44cc74420caf3642c33bcb4b4752eff6132c`，未部署本地工作区代码。

CLI 安全回读 `DRAMA_CDN_ENABLED=false`；实验 ID 不变；本机摘要比对确认 `DRAMA_CDN_BASE_URL`、`DRAMA_CDN_EXPERIMENT_ID`、`DRAMA_CDN_EXPERIMENT_KEY`、`DRAMA_CDN_TOKEN_KEY` 均不变。仅写入一个开关，不操作 Bunny 节点、历史数据、其他服务或在播媒体。health 正常只证明服务健康，不代表视频播放验收。

[部署与配置证据](../.trellis/tasks/10-29-drama-cdn-rollout/research/closure-20261104-deployment.json)。关流后 iOS 新播放、换集和来源验收的更新见下文；Android 无设备，未验。旧地址、预取及迟到响应的保护已按当前生产源码核对，尚不冒充关流后的真实竞态测试。

本次仅运行时变量和运维证据变更，无产品代码/契约/数据库变更；因此未把旧工作树的 typecheck、build、mock 播放测试当作当前生产验收。已完成统计复算、JSON 解析、diff whitespace、目标/部署/副本和变量安全回读检查。上述为验收节点记录；后续按用户明确授权，将本报告、执行记录及 5 个 research 文件单独提交并推送，创建指向 main 的 PR，暂不合并。

截至 `2026-11-04T03:05:57Z`（北京时间 11:05:57），关流后同口径服务级查询返回 0 条新遥测，尚不能确认实际播放器 provider。用户已表示有 iOS 设备，但三项手动操作结果尚未收到：新播放待验、换集待验、失败后重试待验。原 Bunny 分组的 Supabase/disabled 实况仍待观察；旧地址/预取/迟到响应的真实关流竞态未执行；Android 未验。具体状态见[播放验收证据](../.trellis/tasks/10-29-drama-cdn-rollout/research/closure-20261104-playback.json)。完整完成标准尚未达成，不将任务标为完成。

### 11:11 验收更新（替代上述早期待验状态）

用户先反馈“已完成”，随后明确澄清：没有出现“重新播放”按钮，第三项实际未测。最终不得将重试记作通过。

- **iOS 新播放通过**：`34c96c99-1bcb-4e4a-b277-22972ea1bb26`，接收时间 11:07:57.133，entry=direct、final=playing、frame_method=video_frame_callback、first_frame=2420ms、playing=2390ms；delivery.provider=supabase、reason=disabled。
- **iOS 换集通过**：4 个 switch 成功终态分别约 2572/2071/2102/3737ms，均有真实首帧与 playing 标记，实际 supabase/disabled；用户已完成换集操作。不同视频观察均重新取址。
- **iOS 失败后重试未测**：用户没有触发失败按钮；本窗口 entry=retry 为 0，不存在可核对的 parent/root 重试成功链。不能用换集或刷新替代。
- **实际来源已确认**：关流后至 11:11:14 的查询收到 30 条遥测，18 条带 delivery 的报告全部为 supabase/disabled，未见 provider=bunny；18 条含重复阶段，不是 18 次独立播放。初次自动播放 autoplay_blocked 终态保留，未改写为成功；另一次 direct 真实首帧成功单独记录。
- **分组限制**：本次用户原组为 supabase。原 Bunny 组关流后的 supabase/disabled 实况尚未重新观察；实验 ID/HMAC key 已保留、分桶与 enabled 独立的当前生产代码已核对，但不将这些替代该实测样本。
- **后续其他发布**：11:10 左右其他发布将生产升级到 `f0353fecd884f46bc011fb8c51b47405d3d566ec`，部署 `2c0a329c-c9e2-4ac2-8cdc-856eb3384549`，1/1 online、无 pending work，安全回读 false/原实验 ID。相对关流 SHA，delivery helper、播放 query 与播放器文件无差异。本次媒体证据属于 `26da44cc`，新 release 暂无新增媒体样本，不篡改原验收版本。

完整剩余项：失败后重试、原 Bunny 分组关流实播、Android、受控旧地址/预取/迟到响应竞态。因此关闭动作及新播放/换集验收已完成，原完整完成标准仍有上述缺口。详细 observation、阶段与部署快照保存在[播放验收证据](../.trellis/tasks/10-29-drama-cdn-rollout/research/closure-20261104-playback.json)。
