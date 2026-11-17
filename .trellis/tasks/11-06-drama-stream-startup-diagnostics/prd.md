# 短剧 Stream 起播提前建连与分片级诊断

## 背景

Stream AB（`drama-stream-prod-20261104-v1`）开流约 47h，Stream 组只压住了极端尾部，中位数反而变差（iOS 设置源→开始播放 P50 4.66s，Supabase 1.97s；Android 2.37s vs 0.75s）。现有诊断只记录 URL 等于主清单的请求，子清单和分片全被过滤；Stream 不返回 Timing-Allow-Origin，只能拿到起止时间；后端只把 ≥5s 的起播写入 Loki，看不到快样本。

## 目标

1. 提前建立到 Stream 域名的连接，压缩 iOS 主清单请求耗时（慢样本中位 1.13s）。
2. 起播诊断能把“设置源→元数据”和“元数据→首帧”拆到每个请求。

## 需求

- Stream 域名来自 Vercel 公开变量 `NEXT_PUBLIC_DRAMA_STREAM_ORIGIN`（已在 production/preview/dev 配置）；没配置或格式不对时不输出任何提示，行为与现在一致。
- 页面加载时为 Stream 域名输出 preconnect；点封面/换剧发出播放意图时再次 preconnect（空闲连接约 10s 会被关闭）。CORS（hls.js）与非 CORS（iOS 原生 `<video>`）各一条。
- iOS 原生 HLS：起播网络记录接收同一 Stream 域名的全部请求，按路径标注 `kind`（manifest/playlist/segment）。
- hls.js：记录清单、子清单、音轨清单、init 段和分片的开始、首字节、结束、加入缓冲时间、字节数、档位、码率、分片序号和媒体时长；起播终态后停止，最多 16 条，超出标 `truncated`。
- 后端：带 `delivery`（CDN 实验组）的起播和快进诊断不受 5s/3s 门槛限制，全量写入 Loki；其余流量规则不变。
- 上报和日志中不得出现媒体 URL 或签名。

## 不做

快进诊断的同类改造（另一窗口，基于本分支）、Grafana 看板（另一窗口）、方向 1 的档位封顶（另一任务）、热门剧预热（暂缓）、清单预取（URL 每次 `/play` 现签，取到地址后约 3ms 就设置源，没有提前窗口）。

## 验收

- shared 测试、frontend/backend typecheck 与相关现有测试通过；新增单测覆盖：URL 不外泄、`kind` 分类、hls 统计映射与上限、实验组全量写入。
- 上线后：Stream 组起播诊断在 Loki 中出现快样本；iOS 记录含 `kind`；Android 记录含 `diagnostics.hls`；iOS 主清单请求中位耗时与基线 1.13s 对比。
- 发布顺序：Railway 后端先于 Vercel 前端（schema 为 strict，旧后端会整份拒收新字段）。
