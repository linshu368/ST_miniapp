# 只读证据与口径

## 2026-10-29 已核实

- 用户最后明确选择`st-engineering-drama`作为扩展基础，撤回了使用`st-drama-playback`的要求；旧SQL恢复不再是待拍板项。
- Grafana Cloud summary：UID `st-engineering-drama`，标题「工程｜03 短剧启动与播放」，24个面板；数据源`grafanacloud-logs`，浏览器selector为`{service_name="st-miniapp"}`，环境production。已有首页首张画面面板ID102/108/106/114/119须保留。
- 当前线上Faro `st_drama_terminal`、`st_drama_playback_window`能读到正常事件；此前6小时有限聚合未见实验分组属性。只用作当前属性缺口证据，不作为实验效果报告或全访问覆盖率。
- 当前`drama.startup_diagnostic`有限样本出现`delivery.experimentId=drama-bunny-prod-20261029-v1`与Supabase分组/路径；这个>=5秒子集不能证明两桶总体或Bunny表现。
- `delivery.ts`由服务端鉴权用户+环境+实验标识HMAC稳定分配20/80，另有服务端实验去重码。客户端响应只给delivery，不给去重码。
- observer mirror现有attributes未加delivery，grafana.safeAttributes只留白名单，因此只在一层加字段不够。
- playbackState拿到/play结果后才绑定delivery；start已经发出。不能把旧start重发一次，或把没有delivery的失败归对照。
- media的flushQuality已有同条playing_ms/rebuffer_ms和per-src释放；通过快照增加delivery，不改变质量计时。
- 云端旧SQL看板已经停止新增写入，历史事实/详情没有本轮实验信息；本次不恢复SQL、不写migration。

## 规范与实现差异

部分spec/docs仍有「本地实现，待发布」字样，和当前Cloud已收到相应信号不完全一致。本任务按当前代码+实际有限Cloud证据说明已知事实，不将旧文案或局部样本泛化为完整生产验收。

## 实施时须再次核验

当前origin/dev `18f21ba6517e810ff577ae89ce5230935dc0ab16`，origin/main `6e5068f350277d05b1eceaba229f762c09b38ca4`；线上前后端可能多release并存。新字段只从实际新版本生效开始比较，发布前再次读取看板防并发覆盖。

新投影未知归属只能表示同时间/版本收到但无delivery的样本，无法证明属于所选实验。用户级SRM/显著性不由播放次数推出；如需此类结论，使用ops/drama-cdn-rollout.md和既有compare-drama-cdn.ts的完整服务端窗口。
