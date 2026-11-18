# 设计

## 方案选择

用户在“新增槽位”和“四套主体模板”之间选择了槽位：四档只差“谁推动剧情”，其余两百多行规则（机器标签、输出顺序、反重复、风格占位符）相同；四套模板会让公共规则四处复制、改漏一份就只在该模式下出错。

## 复用调研

| 检索对象                                                             | 结论                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pref_word_count_tiers`（单选档位 + 默认档 + 公开投影）              | 复用其形状与“存值原样、读取时解析回落默认档”的口径，不复用其类型（字段不同）                        |
| `reply_style_options` / `applyReplyStyles`（运营目录 + 模板 marker） | 复用读取与降级日志写法；剧情模式是单选，用固定占位符 `{{DRIVE_RULES}}`，不用自定义 marker           |
| `InstructionSlotRules` 槽位（choice/status/memory）                  | 模板侧同样是占位符替换；取值来源不同（按用户所选档位，而非按轮次 full/concise/off），故不并入该结构 |
| `fetchPlatformInstructions` 版本缓存                                 | 新 key 并入同一次读取与 version 签名，配置发布后无需重启                                            |
| `20261112_free_zone.sql` managed key 包装链                          | 照搬：库里只校验 JSON 形状，字段规则在 shared zod                                                   |
| `persistRichReplyDiagnosis` / `rich_reply_metadata`                  | 复用写入每轮档位；表上 CHECK 只要求三个键存在，允许附加键，不改热表结构                             |
| 前端 `usePatchGenerationConfigMutation` 乐观合并                     | 新字段走通用字段路径，无需改 hook                                                                   |

## 数据与契约

- shared `drive-modes.ts`：`DriveModesConfigSchema`（modes 1..8，id 唯一，默认档必须存在且启用）、`PublicDriveModesSchema`、`resolveDriveMode`、`toPublicDriveModes`、`FALLBACK_DRIVE_RULES`、`DEFAULT_DRIVE_MODES_CONFIG`。
- `UserGenerationConfig.pref_drive_mode?`（已解析的生效 id）；`Get/PatchGenerationConfigData.drive_modes?`；`PatchGenerationConfigRequest.pref_drive_mode?`；`PatchUserSettingsRequest.pref_drive_mode?`。
- DB：`app_core.miniapp_user_settings.pref_drive_mode text NULL` + CHECK（id 形状）；`drive_mode_options` managed key。领域归属：app_core（用户长期偏好，权威写入方为后端生成偏好 PATCH）+ admin（运营配置）。无新表/视图/函数之外的跨 schema 依赖。

## 运行链路

1. `fetchPlatformInstructions` 读取 `drive_mode_options` → `instructions.driveModes`（损坏为 null 并 `engine.drive_modes_degraded`）；模板缺占位符而模式已配置 → `engine.drive_slot_missing`，snapshot 置 degraded（沿用 `conversation.instructions.degraded`）。
2. `getGenerationContext` 解析用户 `pref_drive_mode` → `config.pref_drive_mode`。
3. `renderPlatformInstructions`：先替换回复风格 marker，再替换 `{{DRIVE_RULES}}`（null 配置时注入保守规则），最后才填用户手写文本，用户文本里的同名字符串不会被展开。
4. `generate.ts` 用同一函数解析本轮档位，写入 `conversation.instruction_slots.resolved` 日志与 `rich_reply_metadata.drive_mode`。
5. 重新生成按当前选择取档（与回复风格一致；槽位模式持久化，剧情模式不持久化）。

## 可靠性

- 无新增外部调用；配置读取沿用既有超时与版本缓存，失败时保持旧缓存（既有逻辑）。
- 写入：普通字段 UPDATE，单字段覆盖，无读改写竞争；校验只接受启用档位，配置不可用时拒绝写入。
- 降级：配置缺失/损坏 → 保守规则（等同上线前防抢话）；模板缺槽位 → 告警并维持模板原有行为。
- 诊断写入是 fire-and-forget 的既有路径，失败只记 warn，不影响回复。

## 最小充分

- 不新增表、RPC、专用运营页面；运营用通用 JSON 编辑器和 CLI。
- 不做每会话模式、不做灰度框架；全局偏好与现有偏好一致。
- 拒绝：为四档各建主体模板；把模式并入 InstructionSlotRules；为每轮档位新增 chat_history 列。

## 演进、发布与回滚

1. TEST 执行迁移 → 验证 → 生产执行迁移。
2. 部署后端与前端：配置缺失时前端不显示栏目，引擎注入保守规则（行为同上线前）。
3. 运营发布（同一时段）：`drive_mode_options`（四档）→ 新主体模板（含共同底线与 `{{DRIVE_RULES}}`）→ 回复风格文本（去掉越界的主导权句子）。
4. 停止条件：发布后 24h 内富文本解析失败率上升、重新生成率显著上升或出现大量替用户说话的反馈。
5. 回滚：先在运营平台回滚主体模板到 v13 并停用/回滚剧情模式与回复风格，再视需要回退代码。顺序不能反：旧代码遇到新模板会把 `{{DRIVE_RULES}}` 原样发给模型。列可保留（可空、无默认值）。
