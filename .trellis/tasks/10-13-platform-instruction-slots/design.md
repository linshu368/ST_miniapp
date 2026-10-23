# Technical Design

## 1. Current flow and reuse

现有链路为：Frontend `generation-config` hooks -> Shared DTO -> Backend conversations route -> `MiniappUserSettingsRepository` -> `app_core.miniapp_user_settings`；生成时由 `runConversationTurn` 开轮，再由 engine 读取 runtime config 并渲染当前 user message。Admin 已有 managed-config 草稿、发布、历史、回滚和环境隔离。

复用决策：

- 复用 `system_instructions`、`pref_show_options`、`fetchRuntimeConfigEntries`、engine 纯渲染层、Frontend 生成偏好组件和 Admin managed-config 发布链。
- 扩展 Shared settings/conversations DTO、用户设置 repository、开轮结果与 engine input。
- 新增三个槽位 runtime-config key；不把九段文案拆成九个 key，也不建立第二套配置服务。
- 不复用 `interaction_mode_blocks`：它只有选项开关两段文案，无法表达三个槽位与激活后的两阶段规则。
- 不修改文本后处理编译器/renderer；它们仅作为最终标签协议 consumer 参与验收。

## 2. Configuration model

建议 key：`choice_rules`、`status_rules`、`memory_rules`。每个 JSONB 值使用同一严格 schema：

```json
{
  "on_first_two_turns": "完整规则",
  "on_later_turns": "简洁延续规则",
  "off": "关闭规则"
}
```

三个 key 分别进入 Admin managed-config 白名单，因此可以独立保存、发布和回滚。`interaction_mode_blocks` 在兼容期保留数据库旧值但不再由新 Backend 消费，避免应用回退时丢失旧配置。

`system_instructions` 继续存 `text_value`，数据库和 Admin 双层校验五个必需占位符，并拒绝把旧 `{{INTERACTION_MODE}}` 当成有效替代。

## 3. Activation window and persistence

> 当前实现说明（2026-10-14）：本节记录最初的用户级两次额度设计，已被
> `20261013_session_scoped_instruction_slot_modes.sql` 和
> `20261014_rich_reply_dynamic_mode.sql` 前向取代。现行真相是每会话第 1～3 轮 full；
> 第 4 轮起仅当前一轮最新 revision 的诊断为 `exact` 时 concise，其他诊断或缺失时 full。
> 旧计数字段只保留作回滚兼容，不再参与运行时选择。

简单使用 `turn_index <= 2` 不符合“从点击生效开始”；仅用进程内计数会在重启/多副本下漂移；仅用异步 `total_round` 会在快速下一轮和并发会话下超发完整文案。

建议把每个逻辑轮最终采用的槽位模式持久化到 `experience.chat_history`，并把每槽位剩余完整规则次数放在 `app_core.miniapp_user_settings`：

- `pref_show_status`、`pref_show_memory`：`BOOLEAN NOT NULL DEFAULT true`；选项继续用 `pref_show_options`。
- 每槽位一个受约束的剩余次数字段，值域 `0..2`。迁移时：开启状态初始化为 2，关闭状态为 0；新用户三个槽位默认开启且剩余次数为 2。
- 用户偏好写入必须通过原子 RPC/事务：只有 `false -> true` 才把对应剩余次数重置为 2；保持 true、修改其他字段或重复请求不得重置。
- 开新逻辑轮时，在数据库事务内锁定用户设置，按每槽位开关/剩余次数确定 `full | concise | off`，只对 `full` 原子减 1，并把三个模式写进新 chat_history revision。
- 重生成同一 `session_id + turn_index` 时复制该逻辑轮已有模式，不读取或扣减当前剩余次数。
- 开轮 RPC 返回三个模式，Backend 只负责按已确定模式渲染，不自行猜测计数。

优先扩展现有 current-postprocess 开轮 wrapper，保持“开轮、后处理版本绑定、槽位模式快照”一次提交；若研究证明直接扩展会显著放大迁移风险，可改为同事务的新内部 RPC，但不得退化为进程计数或非原子 read-then-write。

## 4. Backend rendering

`PlatformInstructionsSnapshot` 读取主体、三槽位配置和字数档位，版本签名覆盖所有现行 key。每个 key 单独解析；缺失或非法时回落对应安全 fallback，并设置 `degraded=true`。

Engine input 增加数据库确定的三个槽位模式。纯函数按模式选择：`full` -> `on_first_two_turns`，`concise` -> `on_later_turns`，`off` -> `off`。

随后替换 `CHOICE_RULES`、`STATUS_RULES`、`MEMORY_RULES`、`WORD_COUNT`、`USER_CUSTOM_INSTRUCTIONS`。重生成读取持久化模式，所以同轮 prompt 规则稳定。

## 5. Frontend and Shared

Shared 为用户可见 DTO 增加 `pref_show_status`、`pref_show_memory`，PATCH 字段保持可选；内部剩余次数和历史模式不暴露给浏览器。

Frontend 在现有 `ChatGenerationSettings` 中增加两个 Switch，继续用 `usePatchGenerationConfigMutation`。mutation pending 时禁止重复点击，成功后以服务端回读为准。

## 6. Admin layout

新增平台规则工作区，参照现有图片配置的 tabs + 共用 `configEditorCard` 模式：选项、状态栏、记忆区、主体模板。槽位编辑器为受控组件，显示三段 TextArea、字段说明和校验，不维护第二份草稿状态。

每个 tab 绑定独立 managed key；主体仍走 text value，槽位走 JSONB。发布/回滚沿用现有确认、版本和环境隔离。

## 7. Reliability and failure model

- 超时：不新增外部调用；沿用开轮/数据库请求的既有 deadline。
- 重试/幂等：重复保存 true 不得重置窗口；同轮 regeneration 复制模式；写操作不由客户端盲重试。
- 并发：用户设置行锁保护每槽位剩余次数；多会话并发最多准确分配两次 full。
- 事务：开轮与模式快照必须同事务；失败不消耗窗口、不留下无模式的可生成行。
- 降级：运营配置损坏使用安全 fallback；数据库无法确定模式则在调用 LLM 前失败，不以 concise 猜测继续。
- 容量：仅增加少量布尔/小整数/模式字段；不扫描历史消息，不增加每轮无界查询。
- 可观测性：记录配置 key/version、degraded、槽位模式和 turn/revision 摘要；不记录规则正文或聊天正文。
- 限流：无新增公网入口，不适用。

## 8. Evolution and recovery

发布顺序：TEST migration -> Backend -> Frontend/Admin -> TEST 验收 -> Production migration -> Backend -> Frontend/Admin。migration 对旧应用向后兼容；旧应用忽略新列和 key。新 Backend 在 migration 未部署时应拒绝启用新协议，而不是生成半兼容 prompt。

应用回退可继续使用保留的 `interaction_mode_blocks`；数据库结构和新配置不删除。配置错误通过 Admin 发布新版本修复；数据库函数/约束缺陷使用 reviewed forward-fix。清理旧 key 另立任务。

## 9. Rejected designs

- 按会话 `turn_index <= 2`：不满足从点击生效重新计数。
- 用时间戳或 `total_round` 推断：并发和异步结算会产生多/少一轮。
- 进程内计数：多副本、重启和重生成不可靠。
- 九个独立 runtime key：运营管理噪声和发布面过大。
- 一个包含全部槽位的大 key：无法满足每个槽位独立发布/回滚。
- 新建通用 prompt 插件框架：当前只有三个稳定槽位，属于过度设计。

## 10. Input and release evidence

2026-10-13 已收到新版主体、状态栏和记忆栏的准确文案。主体规定了三个槽位、固定输出顺序和小写机器标签；状态栏、记忆栏附件是各自开启后前两轮使用的完整规则。选项的既有运营文案作为迁移输入，三个槽位的简洁/关闭文案均由本次可运营配置承载。

用户已确认 TEST 正则与新版主体对齐；本轮未直接读取远程配置，故该项只作为 TEST 输入记录。Production 后处理规则仍须在 Production 发布前实况核对，不能从 TEST 结论推断。

## 11. T2 implementation record (2026-10-13)

- `app_core.miniapp_user_settings` 新增状态/记忆开关和三个 `SMALLINT 0..2` 计数；历史选项值保留，关闭初始化为 0、开启为 2。开关触发器仅在对应值实际变更时重置，重复 true 与其他槽位更新不会重置。
- `experience.chat_history` 新增三个可空模式快照；NULL 只代表 migration 前历史。新逻辑轮在 current-postprocess wrapper 的同一事务内锁定设置、领取模式并写入 snapshot；重生成只复制同轮既有 snapshot，不扣减。无快照的历史轮重生成会失败回滚，不猜测模式。
- T2 不新增 runtime-config key 或浏览器 DTO；这些消费层仍属于 T3–T6。`interaction_mode_blocks` 未被本 migration 读取、更新或删除。

## 12. T3 implementation record (2026-10-13)

- Shared 的用户设置和生成配置读模型新增 `pref_show_status`、`pref_show_memory`；PATCH 两处字段保持 optional，并用严格 Zod schema 拒绝未知字段和非布尔值。
- Backend repository 仅扩展行类型、generation-config select/映射及既有 PATCH 字段适配；数据库行缺少新增开关时，对外读模型回退为 `true`。规则剩余计数与 `chat_history` 的 `full` / `concise` / `off` snapshot 不在任何 Shared DTO/schema 中出现。
- 本步骤没有调用 T2 偏好 RPC，也没有读取、返回或消费单轮模式；这些写入原子性和 prompt 行为仍由 T4 实现。
