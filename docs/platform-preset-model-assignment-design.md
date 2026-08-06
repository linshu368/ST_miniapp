# 0721平台预设按模型分配机制开发指南

## 背景

当前运营平台已经支持平台预设池，预设内容存储在 `st_platform.platform_presets`，默认预设通过 ST 指针 `platform_<preset_id>` 写入 `oai_settings.preset_settings_openai` 后生效。

现有问题是所有模型共用同一份默认预设。不同模型的能力、上下文长度、推理风格和提示词适配方式不同，共用预设会限制运营按模型调优。

本机制目标是在现有预设池基础上增加“按模型分配专属预设”的能力：

- 运营可以在预设池中保存多个预设。
- 每个预设可以分配给一个或多个模型。
- 每个模型最多拥有一个当前有效的专属预设。
- 模型有有效专属预设时优先使用专属预设。
- 模型没有专属预设，或专属预设为空、停用、删除、不可解析时，回退使用当前全局默认预设。

## 关键概念

### 模型目录

`llm_model_catalog` 是运营配置中的模型目录，当前存储在 Supabase `miniapp.runtime_config`，key 为 `llm_model_catalog`。运营平台左侧“运营配置 / 模型目录”编辑的就是这份配置。

预设分配应绑定模型目录中的平台内部稳定模型 ID：

```json
{
  "id": "gemini-flash-lite",
  "openrouter_model_id": "google/gemini-3.1-flash-lite",
  "display_name": "Gemini Flash Lite"
}
```

其中：

- `id` 是平台内部稳定模型 ID，适合作为预设分配键。
- `openrouter_model_id` 是实际传给 OpenRouter 的模型 ID，不建议作为分配键。

### 预设指针

ST 当前识别的预设指针格式为：

```text
platform_<preset_id>
```

运行时最终仍然通过修改 `oai_settings.preset_settings_openai` 来生效：

```text
oai_settings.preset_settings_openai = platform_<effective_preset_id>
```

新增的模型分配机制只负责解析 `effective_preset_id`。

### `effective_preset_id` 与 `effective_preset_pointer`

`effective_preset_id` 表示“当前模型本次实际应该使用的预设 UUID”。它不是新表字段的名字，而是后端解析模型分配关系后的结果：

```text
effective_preset_id = 模型专属有效 preset_id ?? 当前全局默认 preset_id
```

`effective_preset_pointer` 是同一个结果转换成 ST 可直接识别的指针字符串：

```text
effective_preset_pointer = platform_<effective_preset_id>
```

两者作用不同：

- `effective_preset_id` 适合后端、日志、审计、接口结构化返回使用。
- `effective_preset_pointer` 适合前端 / ST extension 直接写入 `oai_settings.preset_settings_openai`。

示例：

```json
{
  "model_id": "claude-sonnet",
  "openrouter_model_id": "anthropic/claude-sonnet-4",
  "effective_preset_id": "11111111-2222-4333-8444-555555555555",
  "effective_preset_pointer": "platform_11111111-2222-4333-8444-555555555555"
}
```

如果模型没有专属预设，`effective_preset_id` 也不应返回 `null`，而应返回当前默认预设的 ID。只有系统没有任何可用默认预设时，接口返回 HTTP 200，并通过 `preset_degraded=true`、`preset_config_code=NO_ENABLED_DEFAULT` 和空 effective preset 显式暴露配置错误。ST 保留最后一次可用预设继续生成，不能因预设配置异常阻断回复。

## 数据模型建议

不要将模型与预设的关系塞入 `llm_model_catalog` 或 `platform_presets.preset_payload`。建议新增独立关系表，保持“模型目录”“预设内容”“分配关系”三者解耦。

### 当前态表

`st_platform.platform_preset_model_assignments`

用于保存每个模型当前唯一有效的专属预设。

建议字段：

```text
model_id      text primary key
preset_id     uuid not null references st_platform.platform_presets(id)
updated_by    uuid / text
updated_at    timestamptz not null default now()
```

约束与语义：

- `model_id` 唯一，保证一个模型同一时间只有一个专属预设。
- `preset_id` 可重复，允许一个预设分配给多个模型。
- 保存分配时校验 `model_id` 存在于当前正式 `llm_model_catalog`。
- 保存分配时拒绝停用预设，并向运营显式提示。
- 运行时只把启用中的预设视为有效；指向停用预设时回退默认预设。
- `preset_id` 外键使用删除限制；预设仍有分配关系时禁止删除。

### 分配版本

使用独立单调递增的 `preset_assignments_version` 标识分配关系变更。Admin RPC 在更新分配关系的同一事务内递增版本，并校验运营保存时看到的版本，避免多人同时操作时静默覆盖。

### 历史审计表

`st_platform.platform_preset_model_assignment_events`

用于记录每次运营调整，保留可追溯历史。

建议字段：

```text
id                 uuid primary key
model_id           text not null
before_preset_id   uuid null
after_preset_id    uuid null
action             text not null
actor_user_id      uuid null
actor_email        text null
created_at         timestamptz not null default now()
```

典型 `action`：

- `assign`
- `reassign`
- `clear`
- `preset_disabled_fallback` 可选，仅当需要记录系统回退事件时使用

当前态表负责低成本查询和稳定运行；事件表负责审计。不要把当前态表设计成纯 append-only 主表。

## 运行时解析规则

核心解析函数可以抽象为：

```text
resolveEffectivePreset(model_id):
  assignment = current assignment for model_id
  if assignment exists and assignment.preset is enabled:
    return assignment.preset_id
  return current default preset_id
```

等价地：

```text
模型专属有效预设 > 全局默认预设
```

只有以下情况才回退默认预设：

- 模型没有分配记录。
- 分配记录的 `preset_id` 为空。
- 分配记录指向的预设不存在。
- 分配记录指向的预设已停用。
- 分配记录无法通过权限或环境校验。

## 运营平台交互

在现有“平台预设”页基础上扩展即可。

建议能力：

- 预设列表新增“适用模型”列，展示已分配模型数量或名称摘要。
- 提供“调整适用模型”入口，打开模型多选弹窗。
- 模型选项来自当前正式 `llm_model_catalog`，只展示可用模型。
- 保存时调用受控 admin RPC，例如 `update_platform_preset_model_assignments(p_preset_id, p_model_ids, p_expected_version)`。
- RPC 内部负责移动分配关系：如果某模型原先分配给其他预设，保存到新预设后旧关系被覆盖，事件表记录变更。

## 后端适配逻辑

后端需要提供一个统一解析能力，按 `model_id` 返回当前有效预设：

```text
resolveEffectivePresetForModel(model_id):
  1. 读取当前正式 llm_model_catalog，确认 model_id 是有效启用模型。
  2. 查询 platform_preset_model_assignments 当前态表。
  3. 如果存在分配，且 preset_id 指向 enabled=true 的 platform_presets 行，则使用该 preset_id。
  4. 否则读取 is_default=true 且 enabled=true 的默认预设。
  5. 返回 effective_preset_id 和 effective_preset_pointer。
```

模型相关接口建议扩展返回字段：

- `/api/v1/models/catalog`：返回当前选中模型对应的 `effective_preset_id` / `effective_preset_pointer`。
- `/api/v1/models/select`：用户切换模型后，返回新模型对应的 `effective_preset_id` / `effective_preset_pointer`。

前端收到 `effective_preset_pointer` 后，通过 bridge 调 ST extension，同时完成两件事：

```text
oai_settings.custom_model = openrouter_model_id
oai_settings.preset_settings_openai = effective_preset_pointer
```

这样 ST 在下一次生成前，既使用正确模型，也使用该模型当前有效预设。

前端每 60 秒检查一次 `preset_assignments_version` 和当前模型的 effective preset。发现变化后，通过 bridge 将完整预设热应用到 ST 内存；模型切换时不等待轮询，立即同步新模型及其预设。正常网络和服务可用条件下，运营修改分配后应在 2 分钟内生效。

`llm-proxy` 不应作为决定预设的主入口。它收到请求时，`messages` 已经由 ST 拼装完成，预设必须更早生效。`llm-proxy` 可以继续读取 `X-ST-Preset-Id`，用于记录本次实际使用的预设，便于审计、分析和排障。

后端应保证只有当模型专属预设为空或无效时才回退默认预设。不要因为查询失败、接口字段缺失或前端未传值而静默使用默认预设；这类情况应尽量记录日志，避免错误分配被掩盖。

## 生效要求

运营调整分配关系后，正常网络和服务可用条件下，应在 2 分钟内使用最新分配；用户主动切换模型时立即使用对应预设。

因此不能只在 provision 阶段静态写死预设指针，还需要通过 60 秒轮询和模型切换响应，保证当前 ST 内存中的 `oai_settings.preset_settings_openai` 及预设内容已热更新。

`llm-proxy` 收到请求时，messages 已经由 ST 组装完成。预设必须在 ST 发起请求前生效，而不是在 `llm-proxy` 转发时才决定。

## 用户个性化预设覆盖

### 需求边界

运营平台管理的是“模型默认应该使用哪套预设”，用户侧要提供的是“我个人希望怎么覆盖部分预设行为”。两者必须隔离：

- 运营写 `st_platform.platform_presets`，维护预设池和模型分配关系。
- 用户不能写回 `st_platform.platform_presets`，避免污染运营预设源。
- 用户只能修改产品明确开放的业务化配置，例如“回复字数设置”。
- 用户不需要理解“预设”概念，UI 上不暴露完整 SillyTavern 预设 JSON。

示例：

```text
运营给 DeepSeek 分配的预设默认回复 300-500 字。
用户在 UI 选择回复 500-800 字。
最终 DeepSeek 本次生成使用 500-800 字，但 platform_presets 中的 DeepSeek 预设仍保持 300-500 字。
```

### 用户偏好是否按模型隔离

决策：用户个性化配置采用跨会话、跨角色、跨模型、跨预设的全局用户偏好，不按模型隔离。

原因：

- 用户感知的是“我的回复字数偏好”，不是“某个模型在某套预设下的字段覆盖”。
- 如果按模型隔离，用户切换模型后字数设置突然恢复默认，会被理解为设置失效或模型不好用。
- 全局用户偏好更符合用户体验，也更容易解释：用户下次主动修改前，设置一直生效。
- 维护成本更低，可以继续使用 `st_users.user_st_settings` 的默认 `audience = 'default'`，不需要引入 `model:<model_id>` 分组合并。

### 生效优先级

最终配置合并顺序应调整为：

```text
平台 settings 基线
  -> 当前模型 effective preset 的 preset_payload
  -> 用户全局个性化覆盖
  -> 平台强制字段
```

等价优先级：

```text
平台强制字段 > 用户全局个性化覆盖 > 当前模型专属预设 > 全局默认预设
```

其中平台强制字段包括 LLM 代理地址、鉴权、模型字段、平台必须锁定的安全与链路字段等。用户覆盖不能影响这些字段。

### 白名单策略

现有 `preset-apply.ts` 中的 `isPresetOwnedWritablePath` 会把预设映射到的 `oai_settings` 字段整体视为平台拥有字段，`merger` 和 `watcher/uploader` 都会过滤这些字段。这一保护不能完全删除，而应改为“精细放行”：

```text
允许覆盖：业务明确开放的用户偏好字段。
继续保护：prompts、prompt_order、extensions、连接字段、模型字段等结构性或安全相关字段。
```

例如“回复字数设置”可以对应到有限字段，如：

```text
oai_settings.openai_max_tokens
```

或后续确定的更准确字段。该字段需要加入用户可覆盖白名单；但 `prompts`、`prompt_order`、`preset_settings_openai`、`custom_url`、`custom_model` 等仍必须保持平台管控。

### Watcher 适配

用户在 UI 上修改“回复字数设置”后，前端通过 bridge 调 ST extension 修改当前 ST settings 中对应字段，并触发 ST 保存 `settings.json`。

`sync-engine watcher` 继续监听 `data/<handle>/settings.json`，但上传逻辑需要支持精细白名单：

```text
1. 读取 settings.json。
2. 读取最新 platform_settings.writable_paths。
3. pick 普通用户白名单字段。
4. 额外允许 pick 用户可覆盖的预设子字段。
5. canonical hash 去重。
6. append-only 写入 st_users.user_st_settings，audience 仍为 default。
```

这样用户偏好仍然进入 `st_users.user_st_settings`，不会回源到 `st_platform.platform_presets`。

当用户选择“使用预设默认”时，不应把 `null` 写入 ST 字段来表示默认。推荐通过 UI / bridge 清除该字段的用户覆盖，使下一次合并自然回落到当前模型预设值。

### Merger 适配

`mergeSettings` 当前先应用预设，再跳过所有预设拥有字段的用户覆盖。新机制下应改为：

```text
1. 基于 platform_settings.settings_jsonb 构造 A 基线。
2. 按当前模型 effective_preset_pointer 应用对应 preset_payload。
3. 从 user_st_settings 中叠加普通白名单字段。
4. 从 user_st_settings 中叠加允许的用户预设覆盖字段。
5. 再写入平台强制字段，例如 custom_url、reverse_proxy、chat_completion_source、custom_model 等。
```

注意：用户覆盖必须发生在应用预设之后，否则当前模型预设会把用户偏好冲掉。

### 用户侧 UI

用户侧不做“预设编辑器”，只提供业务化设置入口。例如：

```text
回复字数：
- 使用模型预设默认
- 短：100-300 字
- 中：300-500 字
- 长：500-800 字
```

该入口对用户表现为“个人偏好设置”，和切换模型一样是平台产品能力。用户不需要知道背后是预设字段覆盖。

用户主动修改是该偏好的唯一更新来源。切换角色、模型、会话或运营切换模型预设，都不应清除用户已设置的全局偏好；除非用户选择“使用模型预设默认”。

## 后续扩展：用户切换模型预设

未来如果要支持“用户可以修改模型的专属预设”，本质上是把模型预设指针扩展为两层：

```text
用户专属模型预设指针 > 运营模型预设指针 > 全局默认预设
```

解析规则：

```text
resolveEffectivePreset(user_id, model_id):
  if 用户给该 model_id 选择过有效 preset_id:
    return 用户选择的 preset_id
  if 运营给该 model_id 分配过有效 preset_id:
    return 运营分配的 preset_id
  return 当前全局默认 preset_id
```

这不是让用户修改 `st_platform.platform_preset_model_assignments`，而是新增用户侧覆盖层。运营分配仍然是平台默认策略，用户分配只对该用户自己生效。

建议新增当前态表：

```text
st_users.user_model_preset_assignments

user_id      uuid not null
model_id     text not null
preset_id    uuid not null references st_platform.platform_presets(id)
updated_at   timestamptz not null default now()

unique(user_id, model_id)
```

可选新增事件表：

```text
st_users.user_model_preset_assignment_events

id                 uuid primary key
user_id            uuid not null
model_id           text not null
before_preset_id   uuid null
after_preset_id    uuid null
action             text not null
created_at         timestamptz not null default now()
```

用户侧表的约束：

- 一个用户对一个模型最多只有一个当前有效预设。
- 一个用户的修改不影响其他用户，也不影响运营的模型-预设分配。
- 如果用户选择的预设被停用、删除或不可用，应回退到运营分配；运营分配也无效时再回退全局默认。
- 如果用户选择“恢复平台默认”，应删除或清空该用户当前模型的覆盖记录，而不是写入无效 preset。

后端 `effective_preset_id` 解析需要从当前的两级升级为三级：

```text
user_model_preset_assignments
  -> platform_preset_model_assignments
  -> platform_presets.is_default
```

前端 UI 不一定直接叫“预设”。更适合包装成“当前模型的回复模式 / 风格模式”，避免让普通用户理解运营预设池概念。

该扩展与“用户个性化预设覆盖”是两类能力：

- 用户切换模型预设：改变当前用户、当前模型使用哪套 preset payload。
- 用户个性化覆盖：在选定 preset payload 之后，继续覆盖少量业务化字段，例如回复字数。

最终优先级会变为：

```text
平台强制字段
  > 用户全局个性化覆盖
  > 用户专属模型预设
  > 运营模型专属预设
  > 全局默认预设
```
