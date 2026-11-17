# 分支会话数据库验收

2026-10-29，本地 PostgreSQL 17 隔离容器，全部合成数据；没有连接远端业务数据库、执行生产迁移、调用模型或真实扣费。

## 可复用入口

```sh
bash scripts/test-conversation-branches-migration.sh
```

脚本创建独立 `postgres:17` 容器，禁用网络、没有主机端口/数据卷，用完自动删除。最小表结构配合仓库现有 072/077 基础函数和后处理、槽位快照、动态模式实际迁移，执行本次迁移两次验证重入，再执行固定 SQL 用例。依赖 Docker、Python 3 和 Bash。

## 已验证行为

- 原会话已聊 200 轮，分支第 20 轮得到原 1–20；分支第 60 轮且 A=50，得到原 11–60，重新编号 1–50。
- 嵌套分支直接冻结真实 history ID，保持所选轮次内的记忆文本与开场快照，不继承后续轮次。
- 原会话重生成后，既有分支继续读原 revision；原会话软删除后仍能继续和幂等恢复既有分支。
- 继承最后一轮可重生成；本地新 revision 仅覆盖本分支同轮，下一轮接 N+1，展示计数不会重复。
- A=50/B=75 时继续生成，原高低水位规则生效，超过高水位后保留 50 轮；普通新会话与普通重生成保持原编号行为。
- 分支只增加 session 与固定引用，不产生复制的 chat_history、计费 ID 或新扣费事实；原 current_chat_history 没有新增继承投影。
- 跨用户、跨会话、过期 revision、流式/失败/空回复锚点、无界 A 均拒绝。每用户每分钟最多 10 次，软删除不清除限速事实，幂等重试不复活已删分支。
- 四个独立连接同时提交相同请求，全部返回同一 ID且只产生一个分支；校验每个并发进程的退出码和结果。
- 继承引用插入时注入异常，整个创建事务回滚，不留下半成品；物理误删仍被继承的源历史被 FK 阻止；完整账户删除可以完成所有级联，没有悬空引用。
- 新表 RLS、service-only 读/执行、禁止直接写引用、invoker 视图、definer RPC 固定搜索路径均有断言。

## 必要的既有 wrapper 窄修复

原 `SELECT ... INTO v_previous_exact` 无结果时值变成 NULL，旧 `OR NOT v_previous_exact` 可能使缺诊断落到 concise。仅修改两个 `*_with_current_postprocess` wrapper 的这一表达式为 `OR NOT COALESCE(v_previous_exact, false)`，继承边界缺少诊断时采用既有 full 模式。

迁移要求每个既定函数签名仅匹配一个旧表达式，或仅有一个已修复表达式；不匹配则整笔迁移失败。替换前后比较 OID、owner、ACL、SECURITY DEFINER 与 proconfig（包括 search_path），保持原身份与权限。验收实际经过现有 wrapper，验证后处理版本绑定、继承重生成、普通开轮/重生成；不是用测试替代函数。

## 读取与跨域边界

创建分支只读取 experience；幂等和限速使用 `conversation-branch:` 命名空间的用户级事务 advisory lock，不查询或锁定 app_core.users。用户有效性依赖来源会话归属验证及既有外键。

新视图没有复制或拼装整段历史 prompt。创建锚点只选 turn_index/assistant_reply，固定引用只选 id/turn_index。列表仓储仍投影 history 的前两个元素；JSONB 元素读取在 PostgreSQL 中可能 detoast 原 JSONB，这与原历史快照读取相同，并不声称彻底免除 detoast。

隔离 EXPLAIN 检查按 session_id 和轮次过滤后，继承表主键与源 history 主键均可用于索引访问。小型合成数据为检查索引资格关闭顺序扫描；这不是生产容量或延迟基准。

## 发布及恢复边界

本轮只有本地代码。正式发布仍需先执行 TEST 迁移/权限检查，再执行生产迁移，并部署 Backend 与 Frontend。

已有分支后，隐藏 UI 入口可止住新增，但必须保留能读取继承前缀的 Backend/RPC 和新增数据；完全旧 Backend 会隐藏继承前缀，不能当成完整回滚方案。必要时采用经过审查的前向修复。不能通过删除引用表恢复旧版。
