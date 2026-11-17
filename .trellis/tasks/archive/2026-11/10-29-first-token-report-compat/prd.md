# 旧 WebView 首字回报兼容性小修

用户授权：顺便修复已证实的小问题，需要大改则先不动。沿用本会话测试通过后先合 dev 再发布的授权。

## 已确认问题与范围

78次缺报中76次对应Chrome90/92用户的完整客户端回复接收事件。首字回报调用`AbortSignal.timeout(3000)`在这些内核上不存在，三次重试均在发请求前报错。修复只限`reportConversationFirstToken`；离页身份缺失、同request_id重复开轮留待独立处理。

## 最小方案与复用

复用现有apiClient、原三次幂等回报、300/1000ms退避、keepalive及AbortController/setTimeout超时惯例。每次尝试用兼容controller信号覆盖排队、响应头和JSON读取，finally清理计时器。不能仅换timeoutMs：现有timedFetch的计时从出队到响应头，无法保持原整个尝试3秒的范围。不新增抽象、端点、队列、落表、扫描或配置；不改计费判定、首字10秒预算和历史数据。

## 验收与回退

风险仅为回报丢失或重试扩大影响计费资格，使用既有client.retry.test.ts补回归，不新增测试文件。覆盖缺少AbortSignal.timeout时实际发送成功、未受理后有限重试、三次传输超时、排队超时、响应体超时及计时器清理。先确认旧代码回归失败，再改函数；Frontend现有全量测试、typecheck/lint/build及仓库静态检查通过。先dev后main，仅本次变更；应用回退无需数据库动作。缺报旧记录不得回填成功或追扣。

完整验证发现生产基线已有5条media-cache测试断言未跟上现有取消信号参数；只同步既有两处断言，不更改影像模块实现。生产基线CI40667339798已失败，本次修复后完整Frontend 489/489通过。模块更新载荷和目标摘要校验通过；仓库全局模块baseline因已有drama-experience.md缺少章节失败，未扩展修复。
