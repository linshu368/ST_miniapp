# 短剧媒体启动最小诊断打点

## 目标与背景

Preview pr-450 / d9872279 的观察 e6d807f1-f6e0-4f08-b6b8-0d7a1f850f7b：点击到首帧 45301 ms，metadata 到首帧 40346 ms，播放接口后端 70 ms。现有日志无法解释媒体启动等待。用户已确认上一轮提出的三类最小打点，要求先补充并继续采样。

## 范围与约束

- 在同一 observation 的慢快照/终态中增加播放调用结果、媒体里程碑、有限事件序列、即时媒体状态及启动期间用户操作。
- 继续使用 drama.frontend_timing、现有鉴权上报和 Pino/Railway；保留 observation/list/request ID 语义。
- 不改变 src、preload、静音、play 调用、超时、重试、首帧成功或自动播放拒绝语义。
- 不记录媒体 URL、签名、对象路径、原始异常或任意正文；状态读取失败不得影响播放或丢弃整个报告。
- 不增加采样请求频率，不新增生产代码文件、依赖、环境变量或数据库对象。
- 本次不做 Resource Timing/首字节采集、Range 抓包、CDN/编码/播放策略优化；不能把缓冲状态解释为网络/解码根因的确定证据。

## 验收标准

1. 同一 observation 可看到 play 调用及成功/拒绝、metadata/loadeddata/canplay/playing/首帧节点；只有 playing 与首帧均到达才成功。
2. 慢快照包含当时 readyState/networkState/paused/currentTime/bufferedAhead 等状态；事件包含 waiting/stalled/suspend 和用户播放/暂停/重试，后台终态可辨识。
3. 事件数量有硬上限且明确截断；未知字段/非法数值仍被 shared schema 拒绝；旧报告继续接受。
4. 切资源、离开、后台及结束后，旧事件和旧 Promise 不能污染新观察；异常和观测失败不改变原播放结果。
5. 扩展既有媒体、计时、上传契约/后端接收测试，不新建测试文件；运行 shared tests、相关 frontend/backend tests、全消费者 typecheck、frontend lint/build 与边界静态检查。
6. 部署后在 Preview 慢网、暂停/恢复、自动播放拒绝、重试、换剧、后台场景核对 Railway。当前本地修改不代表远端已验收。

## 授权与决策

用户在上一轮三类最小打点方案后明确回复「ok，先补充上述最小打点，看下耗时详情」。本计划将已审核范围落盘，不增加产品/UX 决策。初始实现授权不含提交、推送与部署；2026-10-27 用户另行明确授权提交并推送本次改动，远端部署结果和真机采样仍待核验。
