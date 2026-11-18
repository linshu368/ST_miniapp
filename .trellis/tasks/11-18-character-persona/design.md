# 设计

## 1. 复用调研

- 取数并行：`features/conversations/turn-preparation.ts` 的 `prepareTurnInputs` 已并行读设置/规则/记忆配置，设定读取并入同一个 `Promise.all`。
- 注入：`features/engine/prompt-engine.ts` 已有"角色卡 + 独立记忆 system"形状，新增同形状的一条。
- 仓库/路由/契约：照 `MiniappCharacterFavoriteRepository`（RPC）、`UserMarksRepository`（表读）、`routes/favorites.ts`、shared zod（`settings.ts`）。
- 前端：`ChatToolsPanel` 的 `panel` 二级页机制（默认声音）、`ToolRow`、回复偏好的行样式；hooks 放 `src/lib/api/`。
- 不复用 `pref_custom_instructions`（"我的偏好"）：它是全局文风指令，随平台规则模板注入；新功能是按卡的人物/世界设定，语义和注入位置都不同。

## 2. 数据（docs/db/CONTRACT.md）

| 表                                    | 域       | 性质 | 权威写入                                                                 | 说明                                                    |
| ------------------------------------- | -------- | ---- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `app_core.user_personas`              | app_core | E    | UserPersonaRepository（RPC `save_user_persona` / `delete_user_persona`） | 用户的主角人设库；随用户级联删除                        |
| `app_core.user_character_preferences` | app_core | S    | UserPersonaRepository（表 upsert）                                       | 用户 × 角色卡：补充设定 + 人设选择；随用户/角色级联删除 |

- 跨域 FK 仅指向根实体 `app_core.users`、`app_core.characters`。
- `persona_id` 用复合外键 `(user_id, persona_id) → user_personas(user_id, id) ON DELETE SET NULL (persona_id)`：数据库保证只能选自己的人设，删除后自动回到"跟随默认"。
- `persona_disabled`（"不使用"）与 `persona_id` 互斥（CHECK）。
- 默认唯一：`user_personas(user_id) WHERE is_default` 部分唯一索引；设默认与数量上限在 RPC 里同事务完成（`pg_advisory_xact_lock`）。
- 读取：RPC `app_core.get_character_prompt_settings(user, character)` 一次返回"补充设定 + 生效人设描述"，始终一行。
- 无 jsonb、无金额、无观测、无任务字段。

## 3. 接口

- `GET /api/characters/:characterId/my-settings` → `{ notes, persona: {mode, persona_id}, personas[] }`（面板一次拿全）。
- `PUT /api/characters/:characterId/my-settings` → 部分更新：`notes` 和/或 `persona`。
- `POST /api/personas`、`PATCH /api/personas/:id`（整对象保存）、`DELETE /api/personas/:id`。
- 错误码：`PERSONA_LIMIT`(409)、`PERSONA_NOT_FOUND`(404)、`INVALID_*`(400)。

## 4. 可靠性

- 读取并入准备期 `Promise.all`，**不吞错**：失败与同批读取同样使本轮失败（静默丢设定违背"一直生效"）。单次主键查询，外部调用有 5s abort。
- 写入：设定 upsert 幂等；人设保存/删除在 RPC 事务内；数量上限与默认唯一并发安全。
- 日志：`conversation.character_settings` 记录是否注入（长度，不记正文）。

## 5. 演进与恢复

- 纯新增表/函数，无旧数据、无回填。发布顺序：migration（TEST→生产）→ 后端 → 前端。
- 回退：回退后端/前端即可；表保留。需要删除对象时 forward-fix。
- 无灰度开关（早期阶段，新功能默认全员可用）。

## 6. 最小充分方案

- 不做 runtime_config 包装文案（常量），不做"我的"页人设库入口，不做人设名字替换，不做统一全局人设。

## 7. 验证

- 引擎单测（空/只补充/只人设/两者/占位符/顺序/压缩截断前后）；契约 schema 单测；路由校验（超长、超限、越权）；前端 typecheck + lint；TEST 库执行迁移后真实读写与一轮生成回放。
