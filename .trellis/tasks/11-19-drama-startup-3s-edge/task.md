# Tasks：短剧双端起播 ≤3s

| ID  | 状态 | 内容                                                                           | 依赖  |
| --- | ---- | ------------------------------------------------------------------------------ | ----- |
| T0  | Todo | shared 诊断字段 + Backend 透传部署                                             | —     |
| T1  | Todo | iOS 默认 hls.js + engine 验收                                                  | T0    |
| T2  | Todo | 客户端首块（视频+音轨+init）预取与 loader                                      | T0    |
| T3  | Todo | 缓冲水位 / ABR / rebuffer 降档                                                 | T2    |
| T4  | Todo | 进页不挡播 + episode/续集 intent                                               | —     |
| T5  | Todo | Backend 发/刷新 edge_ticket + KV uid 同步；Worker 只验票后签 Stream JWT + 灰度 | T0    |
| T6  | Todo | 前端持票优先边缘 /play，过期续票或回退 Railway                                 | T5    |
| T7  | Todo | 首片边缘预热 Cron（PoP 暖）                                                    | T5    |
| T8  | Todo | 双端 7 天门禁验收与文档勾选                                                    | T1–T7 |
| T9  | Todo | （可选）R2 主动首块 E2，仅门禁差一线时                                         | T8    |

## 建议 PR 切片

1. PR-A：T0+T1+T2+T3+T4（纯客户端+诊断，Railway）
2. PR-B：T5+T6（边缘签）
3. PR-C：T7（预热）
4. PR-D：T8 报告；必要时 T9
