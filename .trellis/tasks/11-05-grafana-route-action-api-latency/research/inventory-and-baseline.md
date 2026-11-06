# 现有能力、层级与基线调研

## 现有信号

| 需求           | 现有信号                                                                  | 缺口                                                       |
| -------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 二/三级页面    | `page.navigation/launch/terminal/stall`，27 个 route template             | 缺分层 dashboard；部分 route 没有可靠生产样本              |
| 按钮           | `startAction` 九个有限动作；Sentry 全覆盖                                 | Grafana 只镜像五个 roleplay action，route 固定 `/chat/:id` |
| 非流式 API     | 浏览器 `api.total/terminal`；服务端 HTTP histogram/counter                | 新 dashboard 需准确排除长流，不可只看 `kind=standard`      |
| SSE            | `roleplay.first_token/full_reply/terminal`；服务端 generation/full stream | 缺按 endpoint/action 与 Android/iOS 汇总的专门 dashboard   |
| Creator polish | `creator.polish.headers/first_text/full/terminal`                         | 协议是 NDJSON，不应伪称 SSE，也不应混普通接口完整时长      |

## 已确认协议

- SSE：`POST /api/v1/conversations/:id/messages`、`POST /api/v1/conversations/:id/regenerate`，`Content-Type: text/event-stream`。
- NDJSON：`POST /api/creator/polish`，`Content-Type: application/x-ndjson`。
- 其它 generation route 并不等同 SSE；普通接口排除规则必须按真实长流 route，而不是简单排除所有 `kind=generation`。

## 历史可复用基线

- `/chat/:id` page-ready：Android 2392ms（N=135）；iOS 3362ms（N=31，低样本）。
- 五入口历史普通 API 分组：Android 可见最高 wallet 3704.15ms；iOS 可见最高 dramas 3857.6ms。新分组发布前不能与旧 `other` 直接比较。
- 聊天点击到首字：Android 4536ms；iOS 5002ms。成功分布受 6 秒截止约束，必须与 timed_out 共同看。
- 按钮和其余二/三级 route 没有完整的当前窗口基线，不补 0；发布后按新 release 建立。

## 性能与安全结论

- 五份 dashboard 本身不进入业务运行时。
- 不采用全局按钮监听；它会增加每次 click 的主线程工作、噪声和高基数风险。
- 既有 Faro exporter 已有 no-op/有界队列/payload 上限/失败丢弃，可承载少量关键 action 镜像。
- dashboard 查询保留 24h/5m 默认和有限维度，避免对 Loki/Mimir 发起无界高频查询。
