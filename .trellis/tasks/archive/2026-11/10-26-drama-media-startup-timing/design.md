# 设计

## 复用调研

- 组件：drama-player.tsx 已持有 video、每次观察及 play/暂停/重试入口；扩展接线，不建第二个播放器或 hook。
- helpers：drama-media.ts 已绑定 src 代际和首帧回调；在这里读取媒体状态与监听有限事件，保留原成功/失败规则。
- tracker：drama-timing.ts 已统一单调时钟、10 秒快照及终态；扩展事件缓存和可释放的状态读取器，不增加第二套计时来源。
- 生命周期：drama-observer.ts/installDramaTiming 已负责后台终态；复用该路径并增加有限生命周期事件。
- contracts：shared/api/drama-timing.ts 严格 schema 和 dramaTimingLogFields 是唯一字段权威；新 media 字段可选，纯数值/布尔/枚举。
- backend/features/repositories：telemetry.ts 直接消费 shared schema/mapper，不需新 handler/feature/repository；不涉及数据库函数。
- tests：复用 drama-media.test.ts、drama-timing.test.ts、telemetry-contract.test.ts 和 backend telemetry.test.ts，不新建测试文件。

## 最小充分方案

新增可选 media 对象：events 为有限枚举事件与相对 atMs，每项可包含媒体状态；snapshot 为慢/终态即时状态，eventsTruncated 标记上限。保留前 32 条事件，超限停止累加；首次关键里程碑 marks 和报告时 snapshot 独立保留。避免 progress/timeupdate 逐帧记录。状态包含 readyState(0..4)、networkState(0..3)、paused/muted/seeking、currentTimeMs、bufferedAheadMs、visibility；play 拒绝只含有限错误分类。事件在现有报告一起发送，不额外 POST。

DramaPlaybackTiming 保存有界事件与临时读取器；报告时读即时状态，完成后释放读取器。observeDramaMedia 注册/解除读取器和监听；旧资源校验与 disposed/outcome 守卫沿用现有机制。播放器只记录原调用的开始、完成/拒绝与显式用户操作，不额外触发 play/pause/load。metadata/loadeddata/canplay/playing/first_frame 可由事件偏移直接计算阶段，避免扩展一套重复 stages。

## 可靠性与故障模型

- 观测读属性或 TimeRanges 抛错：降级缺失状态，继续播放和既有报告，不记录原始异常。
- 迟到媒体事件/Promise、换源及卸载：保留实例代际守卫，dispose 取消监听；终态后不补写。
- 容量/限流：32 条事件、数值/枚举严格上限、继续 32 KiB body 和既有上报次数/速率限制；快照数组深拷贝，慢报告不被后续状态修改。
- 超时/重试：没有新外部调用；复用上报 5 秒预算、不重试；不改业务调用的策略。
- 幂等/并发：同一观察仅一终态；异步调用结果只写持有的 flow，不经全局 ensure 重建旧流。
- 事务/补偿/数据库：不适用，无持久业务写入。
- 降级：缺媒体状态或事件缺失明确按缺失处理，不据此推断成功、网络吞吐或解码耗时。
- 可观测性：仅现有集中日志；首字节与 Range 仍须浏览器网络取证，不虚构精确传输指标。

## 演进与恢复

先部署含扩展 shared validator 的 Backend，再部署 Frontend；旧前端不带 media 仍兼容，旧 Backend 严格 schema 会拒绝新字段但不影响视频。没有迁移或旧数据修复。停止条件为新字段导致上传失败或影响原播放行为；回滚应用版本，先回退 Frontend 再回退 Backend。未经单独授权不提交/推送/部署。

## 拒绝的过度设计

不建通用媒体遥测框架、不逐帧/周期轮询、不拦截媒体 fetch、不做代理、不新增网络采集、跨会话持久化或自动诊断规则。初始打点只覆盖启动，首帧后操作不扩张为播放中卡顿监控。
