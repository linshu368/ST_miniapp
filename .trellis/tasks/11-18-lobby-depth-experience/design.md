# 技术设计

## 复用调研

- 复用 `packages/backend/src/lib/lobby-ranking-refresh-job.ts` 的每日刷新、专用 `DIRECT_URL`、advisory lock、短事务落表和失败保留快照。
- 复用 `packages/backend/src/features/lobby/ranking-stats.ts` 的窄字段聊天历史读取和 30 分钟 session 切分语义，新增独立的深度摘要查询，避免把深度次数混进质量评分资格口径。
- 复用 `miniapp_features.get_character_socials` 的社交聚合入口。它当前已经合并角色卡点赞和回复点赞，只追加摘要表的一列。
- 复用 `packages/frontend/src/lib/api/character-social.ts`、`CharacterSocialBar` 和既有 `CharacterSocial` 契约。展示字段仍是 `like_count`，不增加前端请求或首屏状态。
- 新增表登记在 `miniapp_features`，因为它是大厅 job 写入、社交 RPC 读取的派生快照，生命周期与角色卡大厅统计一致。不会把统计结果写入 `experience.chat_history`。

## 数据流

```text
每日 lobby ranking refresh
  -> dedicated DIRECT_URL
  -> 读取 chat_history 窄列并按 30 分钟切 session
  -> session rounds > 20 聚合到 character_deep_experience_stats
  -> get_character_socials LEFT JOIN 摘要
  -> 既有 /api/characters/social
  -> 既有 CharacterSocialBar 的 like_count
```

深度摘要表使用 `character_id` 主键、`deep_session_count bigint` 和 `computed_at`。刷新采用覆盖式 upsert，结果为空或任务失败时不清理旧摘要。角色卡不存在时通过外键自然删除。

## 可靠性与性能

- 聊天历史聚合只在现有离线 job 的专用连接中执行，不进入大厅 API。
- 结构化行按 `(session_id, turn_index)` 先去重，legacy 行按物理行保留，避免重生成放大轮数。
- session 切分使用 `created_at - lag(created_at) > interval '30 minutes'`，恰好 30 分钟不切分。
- 社交 RPC 只按最多 40 个角色 ID 访问摘要表，主键连接有界，不读取 `chat_history`。
- 刷新同现有质量快照使用 advisory lock 和短事务。查询超时、连接故障或空结果只保留旧摘要。摘要写入幂等，可安全重跑。
- 不新增重试、不新增读路径缓存层、不新增前端请求。旧数据库未执行迁移时由部署顺序保证 RPC 与表同步，旧客户端继续使用原 `like_count`。

## 演进与恢复

发布顺序为迁移 → Backend → Frontend（Frontend 无代码变化）。迁移先创建表和索引、扩展 RPC，回滚应用时保留摘要表和旧 RPC 兼容。若深度聚合异常，社交接口继续返回旧摘要。若业务需要撤回，先恢复 RPC 加法，再保留表供后续分析，删除表另行审批。

## 拒绝的过度设计

不新增实时计数触发器、消息写入同步计算、队列、用户级明细表或前端独立展示字段。当前目标是低开销地把一个小策略接入已有点赞口径，日级更新足够。
