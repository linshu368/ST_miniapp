# 平台规则模板槽位与动态完整规则

## Goal

把现有平台 instruction prompt 升级为主体模板加三个独立用户槽位：选项、状态栏、记忆区。用户可分别开关；每个会话的第 1～3 个逻辑轮使用完整规则，第 4 轮起根据上一轮富回复诊断动态选择完整或简洁规则。Admin 在同一「平台规则」页面独立管理主体模板及三个槽位的文案、草稿、发布、历史和回滚。

## Requirements

### Prompt 与槽位

- `system_instructions` 必须包含 `{{CHOICE_RULES}}`、`{{STATUS_RULES}}`、`{{MEMORY_RULES}}`、`{{WORD_COUNT}}`、`{{USER_CUSTOM_INSTRUCTIONS}}`。
- 废弃 `{{INTERACTION_MODE}}`；新生成链路不得再读取或替换它。
- 每个槽位有三段运营文案：full 文案、concise 文案、关闭文案。数据库兼容字段仍名为 `on_first_two_turns` / `on_later_turns`，但运行时不再按字段名做固定两轮计数。
- 关闭时始终注入关闭文案，不输出对应标签。
- 每个独立 `session_id` 的第 1～3 个逻辑轮使用 full；第 4 轮起，上一逻辑轮最新 revision 诊断为 `exact` 时使用 concise，诊断为 `recovered`、`failed` 或缺失时恢复 full。
- 同一逻辑轮重生成根据被替换 revision 的诊断重新选择模式，并把结果写入新 revision。
- 三个槽位共享本轮的 full/concise 判断但独立开关；一个槽位关闭不影响其他槽位，重新开启后从下一次生成起使用当轮动态模式。

### 用户偏好

- 选项继续复用 `pref_show_options`，保留现有用户历史值，数据库默认保持开启。
- 新增状态栏、记忆栏用户偏好，默认开启。
- 用户设置仍是用户级配置，对所有会话生效。
- Frontend「生成偏好」增加状态栏、记忆栏开关，并继续通过既有 React Query/API 链路读写。

### Admin

- 现有「平台规则模板」入口升级为同一页面中的平台规则工作区，槽位管理入口排列在主体模板之前。
- 选项、状态栏、记忆区各自可编辑三段文案，并拥有独立草稿、发布版本、历史和回滚。
- 主体模板继续使用现有 text managed-config 发布链；槽位配置复用现有 managed-config 状态机和环境隔离。
- TEST 与 Production 配置、草稿和发布记录不得混用；Production 写操作继续二次确认。

### 配套与边界

- 正则和富文本规则不在本任务中重做；实施与验收时必须分别核对 TEST/Production 已发布规则与 `[choice]`、`[status]`、`[memory]` 的真实标签格式。
- 新版主体、状态栏和记忆栏的完整规则文案以 2026-10-13 用户提供的附件为准；选项槽位继续沿用现有运营文案作为迁移输入，并在 Admin 中独立可编辑。
- 不新增第二套 runtime-config、Admin 发布或前端请求体系。

## Acceptance Criteria

- [ ] 主体模板必需三个新槽位且拒绝 `{{INTERACTION_MODE}}` 作为现行槽位。
- [ ] 三个槽位关闭时分别注入可运营编辑的关闭文案。
- [ ] 每个新会话第 1～3 个逻辑轮使用 full；第 4 轮起仅在上一轮为 `exact` 时使用 concise，`recovered` / `failed` / 缺失时恢复 full。
- [ ] 同轮重生成按被替换 revision 的诊断重新选择规则模式；跨会话并发不会覆盖其他会话的模式快照。
- [ ] 选项历史值保留且默认开启；状态栏、记忆栏默认开启。
- [ ] Frontend 三个开关可独立保存、刷新回读并影响后续生成。
- [ ] Admin 同一页面可独立管理三种槽位的三段文案和主体模板，草稿/发布/回滚与环境隔离保持有效。
- [ ] 配置缺失或非法时 Backend 使用安全 fallback、标记 degraded 并记录不含正文的安全日志。
- [ ] TEST/Production 已发布后处理规则的标签协议被分别核对，模型输出协议与其一致。
- [ ] migration、Shared、Backend、Frontend、Admin 的适用 typecheck/test/build 与人工 1～4 轮及诊断恢复矩阵通过。

## Release gate

- 用户已确认 TEST 已发布正则与新版主体对齐；该结论记录为本任务的 TEST 输入，未在本轮直接读取远程配置。
- Production 已发布正则的实际标签协议仍须在 Production 发布前以只读方式核对；不得由 TEST 结论推断。

## Notes

- 本任务为复杂跨层任务；已在文案输入补齐后进入 `in_progress`。Production 标签协议仍是 Production 发布门禁。
