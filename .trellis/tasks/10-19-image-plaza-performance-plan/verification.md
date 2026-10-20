# 实施验证记录（2026-10-19）

## 范围与状态

用户授权后 task.py start 已把 planning 改为 in_progress；IDE 没有 Trellis session identity，活动指针未保存，任务状态文件已更新。当前源码完成，**不能视为可发布验收完成**。

实现：推荐/最新与筛选绑定 v1 游标、两分区补页与 bigint 文本精度、NULL 新作品兜底；手工单事务一次初始化 migration；工作室内部滚动与本地参考图预览；详情渐进图片、字段级乐观点赞/错误恢复与失效页链刷新。旧无 sort 路径保留。

## 已执行

- 先验证基线：backend 两既有文件 12 测试通过；shared Vitest 缺失，frontend 因 Vitest/workspace 链接缺失有 61 错误。
- `pnpm install --frozen-lockfile --ignore-scripts` 恢复既有声明依赖，未改 package.json/lockfile、未新增库。
- `pnpm -r typecheck`：全部五包通过。
- shared 全量：16 文件、169 测试通过。
- frontend 全量：41 文件、256 测试通过（新增 6 项缓存与文件校验）。
- backend 全量：91 文件通过、1 文件跳过；723 测试通过、13 跳过。既有会话集成测试报告目标库不可用/超时后跳过，不能视为数据库验证；本任务未向该库执行 migration。
- 图片广场 backend 两文件：21 测试通过，包含跨区补页/排除已选 ID、NULL/bigint 游标、错版/错筛选/错 sort 拒绝、route 400 与 legacy 分支。
- Frontend 与 Admin build 通过；Backend/Shared 无 build script，以 typecheck/test 校验。
- frontend lint 无错误，现有 `<img>` 优化警告保留；未为了清警告引入改变私有签名图像行为的 Next Image。
- lint:migrations、lint:legacy 通过。
- 根 lint:imports 在 Windows 下因脚本单引号传参失败；等价 ESLint 命令（双引号 glob，省略空 `--rule '{}'`）通过，未改无关脚本。
- 第一轮 frontend build 曾遭终端命令捕获异常，已重新执行并读取退出码 0 和路由产物清单，不依赖那次失败日志。

## 发布阻断与剩余风险

**环境故障及恢复**：22:27 复验发现本地 node_modules 缺失 Next webpack-build `./impl`、Next 类型和 Vitest sourcemap-codec，导致该轮检查失败。随后 `pnpm install --frozen-lockfile --ignore-scripts --force` 完成（1m15.6s），保持版本/锁文件不变。22:31 重跑全五包 typecheck、backend 21 项相关测试、frontend 6 项回归全部通过；随后 Frontend build 再次成功并生成路由产物。缺失原因未确定，但本次最终复验已恢复通过。模块索引重建和 module_knowledge check 通过；diff --check 通过（仅 Git LF/CRLF 警告）。原始运行日志不作为交付文件，避免混入无关测试输出。

1. 未确认/连接 TEST MCP，未执行远端 SQL。无本地 psql/Docker；migration SQL 实际执行、初始化原子失败/重复拒绝、并发、RLS/ACL、PostgREST cast 和索引 EXPLAIN 还未验证。候选索引收益不能仅由 mock 推断。
2. 1x/10x 数据量、深页/搜索、并发点赞、锁/WAL/空间/索引写成本以及生产独立审批尚未完成。具体 pre/postflight 与恢复在迁移 README。
3. 无浏览器自动化/Telegram 设备；尚未实测滚动 30 轮、软键盘/横竖屏/320px/reduced motion，或参考图 A→B/移除/换模型/会话/卸载晚到、20 次 object URL 释放与内存。Node helper 测试不证明这些 DOM 行为。
4. 交互反馈 p95≤100ms 和服务端处理改善未测。后端点赞原本已只有一个事务 RPC，没有足够 trace 证据改它；本次减少客户端确认 GET/全 feed refetch 并加入安全耗时日志，不宣称 RPC 本身更快。
5. 推荐两分区查询不是单快照，跨请求实时点赞会造成重漏；页内排除 ID 防重复，不恢复遗漏。点赞后暂停续页并刷新第一页。
6. 新 DB 分区/水合读取有 deadline；既有 Storage 签名/upload SDK 调用尚未全路径服务端 deadline 治理。客户端有显式上传/详情/点赞预算，不冒充服务端事务取消。
7. 未检索到已上传但未引用参考图的自动清理任务；取消只释放浏览器资源，不删除远端对象以免误删共享引用。连续替换可能留下未引用资产，容量治理需独立核验。

## 可重复人工流程

- TEST migration 验证后：推荐/最新各遍历多页；A/B/C 100/10/1 模型数据，1/2/10赞、零赞有序位/NULL、同时间与热度空值；点赞/取消至零赞、跨页变动、过滤特殊字符与标签，刷新恢复。
- 工作室：底部/上滑超过120px各轮询30次、无变化不移动；图片慢加载/失败、发送、终态、键盘开合、会话切换，历史不得被强拉。
- 参考图：选A未完成立即选B、删除、切模型/会话、卸载；A晚到不得覆盖B；读取/上传失败保留预览且禁止生成；重试/移除恢复，20轮记录URL释放。
- 详情/点赞：冷热缓存/深链/原图失败/签名过期/404/鉴权失败；两作品同时点赞、同作品连点、超时但服务端提交；失败只回滚目标，成功不额外GET确认，全列表不瞬间跳位。
- 同设备/网络每组至少30次记录 p50/p95/失败数与请求数；任何未解释的 p95 回退>10%、权限问题、错引用或分页混接阻断发布。
