# 设计：创作者删除自己的角色卡

## 1. 核心思路

现有的「设为私密」已经满足需求的一大半：

- 公开入口统一用 `app_core.can_discover_character`，或者与它同口径的 Prisma `discoverableCharacterWhere`、作者主页 SQL、心愿函数来判断，都要求 `visibility='public' AND approved_revision IS NOT NULL`；私密卡在这些地方都会消失。
- 使用权由 `app_core.can_use_character` 判断：作者本人，或者有 `character_access_grants` 的玩家（收藏和建会话时写入），在 `state='ready'` 时可以继续用。非作者使用的是 `published_revision` 那一版（`bind_creator_character_version`），删除时不动它。

所以 **删除 = 强制转私密 + 打上已删除标记**。作者列表、编辑读取和后续写入按这个标记拦掉，公开侧和使用权不需要改。

## 2. 数据库（落位）

`app_core.character_creations` 新增 `deleted_at timestamptz NULL`。

- 坐标：app_core × S（作者草稿与发布状态），与表一致。
- 唯一写入方：`backend/src/features/creator` 经 `app_core.mutate_creator_character(...,'delete',...)`，和其他作者写入同一个函数、同一把锁。
- 生命周期：跟行一起，删除后不清空（不提供恢复）。
- 读者：`CreatorCharacterRepository.list/get`（过滤），函数自身（拒绝后续写入）。
- 符合 CONTRACT 落位卡第 2 条（同性质、同写入模块、有读者）；这张表不在 frozen/moving 名单里，不是热表。不需要索引：作者列表走现有的 `(owner_user_id, updated_at DESC)` 索引，单个作者最多 200 行。

`mutate_creator_character` 整体 `CREATE OR REPLACE`，改三处：

1. `p_action` 允许 `'delete'`。
2. `create` 重放：如果已删除，按 P0404 拒绝（不会把删掉的卡"复活"给作者）。
3. 锁行之后：已删除且动作不是 `delete` → P0404；动作是 `delete` → 已删则原样返回（幂等），否则在同一条 UPDATE 里写 `visibility='private'`，清掉审核/提交字段（和现在转私密的分支一样），`deleted_at=now()`、`revision+1`、`last_mutation=NULL`，然后返回。不需要 `expected_revision`：删除不依赖草稿内容，作者在别处打开的编辑页再保存会拿到 404。

`review_creator_character` 要求 `visibility='public'` 且待审核，删除后自然拒绝，不用改。`can_discover_character`/`can_use_character`/心愿函数/收藏函数都不用改。

迁移前置检查：函数现有源码的 md5 必须等于生产实测值 `160f07aba2b38e80ba8fa85032f3dd5e`，或者源码里已经有 `deleted_at`（重跑的情况）；否则拒绝执行，避免覆盖不知道的改动。

## 3. 后端

- `CreatorCharacterRepository`：`list` 和 `get` 都加 `.is('deleted_at', null)`；新增 `remove(id, ownerId)`，调用上面的 RPC，`p_payload` 传 `{}`。
- 路由：`DELETE /api/creator/characters/:id`，用现有的 `ownerOptions` 和 `handle('delete')`（错误映射 P0404→404，日志 `creator operation` 自带 action、status、duration_ms），并绑定 `character_id` 业务上下文。成功后调用 `clearLobbyFeaturedSnapshot()`（和改可见性一样），返回 `{ deleted: true }`。

## 4. 契约

`packages/shared/src/api/creator-characters.ts` 新增 `DeleteCreatorCharacterData { deleted: true }`。没有请求体。

## 5. 前端

- `lib/api/creator-characters.ts`：新增 `useDeleteCreatorCharacterMutation`（DELETE，`retry:false`，超时 15s）。成功后从列表缓存里直接移除这张卡、删掉详情缓存，并让列表、`['characters']`、收藏缓存失效（作者自己的大厅和收藏视图也要刷新）。
- `created-characters.tsx`：`article` 加 `relative`，封面右上角放一个 44px 触区的「⋯」按钮（视觉上是 28px 的半透明黑圆，不用 backdrop-blur），放在 Link 外面，避免嵌套交互元素。点击打开底部 Sheet：标题「删除「名字」？」，说明「删除后会从我的创作和大厅移除，无法恢复。已收藏或聊过的玩家仍可继续使用。」，红色按钮「确认删除」/「正在删除…」，错误显示在 Sheet 里。Sheet 复用可见性确认框的组件和样式。
- 文件目前 346 行，加完不超过 500 行；如果 `CreatedCharacters` 函数超过 120 行的预算，就把删除确认框拆成同文件里的小组件。

## 6. 复用调研

| 检索对象                                                                                                           | 结论                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `can_discover_character` / `discoverableCharacterWhere` / 作者主页 SQL / `mutate_character_wish`                   | 复用：私密即不可发现，不用改                                       |
| `can_use_character` / `character_access_grants` / `set_character_favorite` / `ChatSessionRepository.createSession` | 复用：已有使用权的玩家照常用                                       |
| `mutate_creator_character`                                                                                         | 扩展：加 `delete` 动作，沿用锁顺序与错误码                         |
| `routes/creator-characters.ts` 的 `handle`/`viewer`/`characterId`                                                  | 复用：错误映射和日志都现成                                         |
| 心愿撤回（`DELETE /api/character-wishes/:id`、`withdrawn_at`）                                                     | 参照它的软删除写法；不共用代码                                     |
| `features.user_marks` / `character_listings.archived_at`                                                           | 不用：前者是一次性 UI 标记；后者归运营排布，发布排布时会被整体改写 |
| 前端 `Sheet`、`useSetCreatorVisibilityMutation`                                                                    | 复用组件，mutation 参照它的缓存失效写法                            |

## 7. 可靠性

- 超时：RPC 8s（沿用 repository 的 `TIMEOUT_MS`）；前端请求 15s。
- 幂等与并发：函数内先加 `pg_advisory_xact_lock` 再锁 `characters` 和 `creations` 行，与保存/发布串行；重复删除返回同一行。和发布并发时，谁后执行谁说了算；删除之后发布会拿到 404。
- 重试：前端不自动重试；用户可以重新点，因为删除幂等。
- 降级：删除失败时卡片保留，Sheet 里提示；不影响列表读取。
- 缓存：大厅精选快照立即清除；目录快照与改可见性的行为一致（没有更强的保证）。

## 8. 演进与恢复

- 发布顺序：TEST 迁移 → 生产迁移 → 后端 → 前端。旧后端碰到新函数没有影响（只是多了一个它不会传的动作）；新后端在迁移前上线的话，`deleted_at` 过滤会报错，所以迁移必须先跑。
- 回滚：回退前端和后端即可，列和函数保留。已删除的卡在旧后端上会重新出现在作者列表里，状态是私密（不会公开）。如果要彻底撤掉：执行本次迁移文件里写的反向 SQL。
- 旧数据：不回填，所有现有行的 `deleted_at` 都是 NULL。
