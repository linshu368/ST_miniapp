# 执行清单

| ID  | 状态 | 工作                                 | 验证                                            |
| --- | ---- | ------------------------------------ | ----------------------------------------------- |
| T0  | Done | 核对最新dev/生产版本、复用及计划门禁 | 保留上游缓存和全局retry=false，记录版本差异     |
| T1  | Done | 有界队列与请求计时                   | client retry / request timing / concurrency回归 |
| T2  | Done | 正文优先级与预取隔离                 | priority / 领域query用例                        |
| T3  | Done | 聊天创建缓存复用                     | 新建/已有/失效及活动会话观察者                  |
| T4  | Done | Android深导航后台让路                | link/返回、失败/4秒释放、StrictMode清理         |
| T5  | Done | 大厅代理结构化失败                   | latest缓存、推荐隔离、cancel/timeout/upstream   |
| T6  | Done | 全量Frontend和移动端既有验收         | typecheck/tests/lint/build/UI/complexity        |
| T7  | Done | 规范及实施报告                       | 13页覆盖、恢复、真实生产验证边界                |
