# SPIKE Report: ST Internal API Validation

> 产出时间：2026-06-23
> 探测范围：`vendor/sillytavern/public/scripts/` (锁定 commit)
> 探测代码：`packages/st-extension/src/spike-probe.ts`

---

## 全局前置发现

**ST 扩展 API 入口**：`globalThis.SillyTavern.getContext()`

```js
// vendor/sillytavern/public/script.js:398
globalThis.SillyTavern = {
  libs,
  getContext,
};
```

`getContext()` 定义在 `scripts/st-context.js`，返回一个包含 ~100 个属性的上下文对象，涵盖事件系统、角色管理、聊天管理、设置保存等全部公开 API。这是扩展与 ST 交互的**唯一官方入口**。

**事件系统**：`scripts/events.js` 导出 `eventSource`（`EventEmitter` 实例）和 `event_types`（111 个事件常量）。`EventEmitter` 支持 **autoFireAfterEmit** 机制：构造时传入 `[APP_READY, APP_INITIALIZED]`，意味着若事件已经 emit 过，后续注册的监听器会自动重放上次参数。

---

## Q1: ST 启动就绪信号

### 探测方法

扫描 `scripts/events.js` 事件定义 + `script.js` 初始化流程 + `lib/eventemitter.js` EventEmitter 实现。

### ST 实际行为

1. `event_types.APP_READY = 'app_ready'` — 在 `script.js:913` 最末尾 emit，此时所有子系统初始化完毕（角色已加载、tokenizer 就绪等）。
2. `event_types.APP_INITIALIZED = 'app_initialized'` — 在 `script.js:910` emit，稍早于 APP_READY。
3. **EventEmitter 支持 barrier 模式**：构造时传入的 `autoFireAfterEmit` 包含 APP_READY 和 APP_INITIALIZED。

```js
// scripts/events.js:113
export const eventSource = new EventEmitter([event_types.APP_READY, event_types.APP_INITIALIZED]);
```

效果：如果扩展在 APP_READY 已经 emit **之后**才调用 `eventSource.on('app_ready', cb)`，`cb` 会被**立即同步调用**（重放上次 emit 的参数）。这保证了无论扩展加载时序如何，都不会错过就绪信号。

4. `DOMContentLoaded` + selector 探测：**不推荐**。ST 初始化是异步的，DOMContentLoaded 时 ST 内部状态机尚未就绪。

### 选定方案

**使用 `eventSource.on(event_types.APP_READY, cb)`**，无需关心加载时序。

### 代码片段

```ts
const ctx = SillyTavern.getContext();
ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
  console.log('ST fully ready, characters loaded:', ctx.characters.length);
  // 安全地开始 bridge 初始化
});
```

### 结论

**APP_READY + barrier 模式** 是最可靠方案。100% 确定。

---

## Q2: 切角色 API

### 探测方法

扫描 `script.js` 中 `selectCharacterById` 导出 + `st-context.js` 中 getContext 暴露清单。

### ST 实际行为

1. **`selectCharacterById(id, { switchMenu })`** — 公开导出函数，通过 `getContext()` 可用。

```js
// script.js:998
export async function selectCharacterById(id, { switchMenu = true } = {}) {
  if (characters[id] === undefined) return;
  if (isChatSaving) {
    /* toast warning, return */
  }
  if (selected_group && is_group_generating) return;

  if (selected_group || String(this_chid) !== String(id)) {
    if (!is_send_press) {
      setCharacterId(undefined);
      setCharacterName('');
      resetSelectedGroup();
      await clearChat({ clearData: true });
      cancelTtsPlay();
      setCharacterId(id);
      chat_metadata = {};
      await getChat(); // 加载该角色的当前 chat
    }
  } else {
    // 已选中同一角色，切换到编辑面板
    switchMenu && (selected_button = 'character_edit');
    await unshallowCharacter(this_chid);
    select_selected_character(this_chid, { switchMenu });
  }
}
```

2. `id` 参数是 `characters[]` 数组的**索引**（number），不是 avatar 字符串。
3. 切换完成后会触发 `CHAT_CHANGED` 事件。
4. `setCharacterId()` 是内部函数，**未导出**，不应直接使用。
5. DOM click `#rm_character_block` 也能触发，但属于 DOM 操作，不稳定。

### 选定方案

**使用 `getContext().selectCharacterById(index, { switchMenu: false })`**。

### 代码片段

```ts
const ctx = SillyTavern.getContext();
// 按角色名查找索引
const targetIndex = ctx.characters.findIndex((c) => c.avatar === 'target_avatar.png');
if (targetIndex >= 0) {
  await ctx.selectCharacterById(targetIndex, { switchMenu: false });
}
```

### 结论

**`selectCharacterById`** 是 ST 公开/稳定路径，通过 `getContext()` 暴露。参数是数组索引（number）。

---

## Q3: 切 chat

### 探测方法

扫描 `script.js` 中 `openCharacterChat` 导出 + `st-context.js` 暴露。

### ST 实际行为

1. **`openCharacterChat(file_name)`** — 公开导出函数，通过 `getContext()` 可用。

```js
// script.js:8763
export async function openCharacterChat(file_name) {
  await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
  await clearChat({ clearData: true });
  characters[this_chid].chat = file_name;
  chat_metadata = {};
  await getChat();
  $('#selected_chat_pole').val(file_name);
  await createOrEditCharacter(new CustomEvent('newChat'));
}
```

2. `file_name` 参数是 chat 文件名（**不含 `.jsonl` 扩展名**），例如 `"CharName - 2024-01-01@12h30m"`。
3. 前置条件：`this_chid` 必须已设置（即当前已选中一个角色）。
4. 切换后会触发 `CHAT_CHANGED` 事件（在 `getChat()` 内部 emit）。

5. **获取 chat 列表**：`getPastCharacterChats(characterId?)` 也是公开导出的。

```js
// script.js:9543
export async function getPastCharacterChats(characterId = null) {
  characterId = characterId ?? parseInt(this_chid);
  if (!characters[characterId]) return [];
  const response = await fetch('/api/characters/chats', {
    method: 'POST',
    body: JSON.stringify({ avatar_url: characters[characterId].avatar }),
    headers: getRequestHeaders(),
  });
  // ... returns sorted array of { file_name, mes, last_mes, file_size }
}
```

注意：`getPastCharacterChats` **未通过 `getContext()` 暴露**，但可以通过 REST API `/api/characters/chats` 直接调用（用 `getContext().getRequestHeaders()` 获取认证头）。

### 选定方案

**使用 `getContext().openCharacterChat(fileName)` 切换 chat**。获取 chat 列表通过 REST 调用 `/api/characters/chats`。

### 代码片段

```ts
const ctx = SillyTavern.getContext();

// 获取 chat 列表
const resp = await fetch('/api/characters/chats', {
  method: 'POST',
  headers: ctx.getRequestHeaders(),
  body: JSON.stringify({ avatar_url: ctx.characters[ctx.characterId].avatar }),
});
const chats = Object.values(await resp.json());

// 切换到指定 chat
await ctx.openCharacterChat(chats[0].file_name.replace('.jsonl', ''));
```

### 结论

**`openCharacterChat(fileName)` 存在且公开**。参数为不含 `.jsonl` 的文件名。

---

## Q4: chat 列表事件

### 探测方法

扫描 `events.js` 所有事件常量 + `script.js` 中 chat 相关事件 emit 位置。

### ST 实际行为

**不存在 `chats_loaded` 事件。** 但有以下替代信号：

| 事件常量       | 实际字符串          | 触发时机                                           |
| -------------- | ------------------- | -------------------------------------------------- |
| `CHAT_CHANGED` | `'chat_id_changed'` | 每次 chat 切换完成后（含角色切换导致的 chat 加载） |
| `CHAT_LOADED`  | `'chatLoaded'`      | chat 加载完成（含首次加载）                        |
| `CHAT_CREATED` | `'chat_created'`    | 新建 chat 时                                       |
| `CHAT_DELETED` | `'chat_deleted'`    | 删除 chat 后                                       |
| `CHAT_RENAMED` | `'chat_renamed'`    | 重命名 chat 后                                     |

关键事件详情：

- **`CHAT_CHANGED`**（`script.js` 多处 emit）：参数为 `chatId` 字符串。每次 chat 切换必然触发。
- **`CHAT_LOADED`**（`'chatLoaded'`）：`getChat()` 完成后 emit，包含已加载的 chat 内容。

**chat 列表本身没有专门的"列表已加载"事件**。chat 列表是通过 REST API `/api/characters/chats` 按需拉取的，ST 前端调用 `displayPastChats()` 渲染但不 emit 事件。

### 选定方案

- 判断 **当前 chat 是否已加载**：监听 `CHAT_CHANGED` 或 `CHAT_LOADED`。
- 获取 **chat 列表数据**：直接调用 REST API `/api/characters/chats`（不依赖事件）。
- 监听 **chat 列表变化**：组合监听 `CHAT_CREATED` + `CHAT_DELETED` + `CHAT_RENAMED` 来知道列表何时变更，然后重新拉取。

### 代码片段

```ts
const ctx = SillyTavern.getContext();
const et = ctx.eventTypes;

// 当前 chat 加载完成
ctx.eventSource.on(et.CHAT_CHANGED, (chatId) => {
  console.log('Chat switched to:', chatId);
});

// chat 列表发生变化 → 重新拉取列表
const refreshChatList = async () => {
  const resp = await fetch('/api/characters/chats', {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify({ avatar_url: ctx.characters[ctx.characterId]?.avatar }),
  });
  return Object.values(await resp.json());
};

ctx.eventSource.on(et.CHAT_CREATED, refreshChatList);
ctx.eventSource.on(et.CHAT_DELETED, refreshChatList);
ctx.eventSource.on(et.CHAT_RENAMED, refreshChatList);
```

### 结论

**没有 `chats_loaded` 事件**。替代方案：`CHAT_CHANGED` 判断当前 chat 就绪 + REST 拉取列表 + `CHAT_CREATED/DELETED/RENAMED` 监听列表变化。

---

## Q5: 删除/置顶/重命名 chat

### 探测方法

扫描 `script.js` 导出函数 + `st-context.js` 暴露清单 + `slash-commands.js` 注册的命令。

### ST 实际行为

#### 5.1 重命名 chat ✅ 有公开 API

```js
// script.js:12025 — 通过 getContext() 暴露
export async function renameChat(oldFileName, newName) {
  return await renameGroupOrCharacterChat({
    characterId: this_chid,
    groupId: selected_group,
    oldFileName: oldFileName,
    newFileName: newName,
    loader: true,
  });
}
```

内部调用 REST API `POST /api/chats/rename`，成功后 emit `CHAT_RENAMED`。

slash 命令：`/renamechat <newName>` — 重命名当前 chat。

#### 5.2 删除 chat ⚠️ 有导出函数但未通过 getContext() 暴露

```js
// script.js:1521 — 导出但不在 getContext() 中
export async function deleteCharacterChatByName(characterId, fileName) {
  await unshallowCharacter(characterId);
  const character = characters[characterId];
  const response = await fetch('/api/chats/delete', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      chatfile: `${fileName}.jsonl`,
      avatar_url: character.avatar,
    }),
  });
  // ... 如果删除的是当前 chat，自动切换到最新 chat
  await eventSource.emit(event_types.CHAT_DELETED, fileName);
}
```

REST 端点 `POST /api/chats/delete` 接受 `{ chatfile, avatar_url }`。

slash 命令：`/delchat` — 但实现较复杂（打开 past chats UI + DOM 操作）。

**替代方案**：直接调用 REST API `/api/chats/delete`，通过 `getContext().getRequestHeaders()` 鉴权。

#### 5.3 置顶/收藏 chat ❌ 无公开 API

ST 没有"置顶 chat"或"收藏 chat"概念。ST 的 "Bookmark" 系统（`scripts/bookmarks.js`）是**聊天分支检查点**机制，不是"置顶"或"收藏"。

chat 排序方式为按 `file_name`（时间戳）降序，无自定义排序字段。

### 选定方案

| 操作   | 方案                                                                |
| ------ | ------------------------------------------------------------------- |
| 重命名 | `getContext().renameChat(oldName, newName)`                         |
| 删除   | REST `POST /api/chats/delete` + 手动 emit `CHAT_DELETED` 事件       |
| 置顶   | **无解** — ST 无此概念。需在平台层（Supabase 镜像）自行维护置顶标记 |

### 代码片段

```ts
const ctx = SillyTavern.getContext();

// 重命名
await ctx.renameChat('OldChatName', 'NewChatName');

// 删除（直接 REST）
await fetch('/api/chats/delete', {
  method: 'POST',
  headers: ctx.getRequestHeaders(),
  body: JSON.stringify({
    chatfile: 'ChatToDelete.jsonl',
    avatar_url: ctx.characters[ctx.characterId].avatar,
  }),
});
// 需要手动处理当前 chat 是否被删（如果是，需切换到另一个 chat）

// 置顶 → 无解，需在平台侧实现
```

### 结论

- **重命名**：有公开 API ✅
- **删除**：有 REST 端点，函数已导出但未在 getContext() 中 ⚠️ → 走 REST
- **置顶**：ST 无此功能 ❌ → 平台层自行实现

---

## Q6: 改 LLM 设置（模型切换）

### 探测方法

扫描 `scripts/openai.js` 中模型切换逻辑 + `st-context.js` 暴露的设置对象 + `events.js` 相关事件。

### ST 实际行为

#### 6.1 读取当前模型

```js
// 通过 getContext() 暴露
const ctx = SillyTavern.getContext();
ctx.mainApi; // 'openai' | 'textgenerationwebui' | 'kobold' | ...
ctx.getChatCompletionModel(); // 当前 chat completion 模型名
ctx.chatCompletionSettings; // oai_settings 对象（完整引用）
ctx.textCompletionSettings; // textgenerationwebui_settings 对象
```

`getChatCompletionModel()` 根据 `chat_completion_source` 返回对应的模型名：

```js
// openai.js:1923
export function getChatCompletionModel(settings = null) {
  settings = settings ?? oai_settings;
  switch (settings.chat_completion_source) {
    case 'claude':
      return settings.claude_model;
    case 'openai':
      return settings.openai_model;
    case 'makersuite':
      return settings.google_model;
    // ... 12+ providers
  }
}
```

#### 6.2 切换模型

ST 的模型切换通过 **DOM select 元素 + jQuery trigger** 实现：

```js
// openai.js:8059
$('#model_openai_select').on('change', onModelChange);
$('#model_claude_select').on('change', onModelChange);
// ... 每个 provider 有对应的 select 元素
```

`onModelChange()` (openai.js:5893) 内部：

1. 读取 select 值
2. 更新 `oai_settings.xxx_model`
3. 调整 max_context 等联动参数
4. 调 `saveSettingsDebounced()`
5. emit `CHATCOMPLETION_MODEL_CHANGED`

**没有直接的 `setModel(name)` 函数**。但可以：

- **方案 A（推荐）**：直接修改 `oai_settings` 对象属性 + 触发 DOM change 事件
- **方案 B**：直接修改 `oai_settings` 属性 + 调 `saveSettingsDebounced()`

#### 6.3 相关事件

| 事件                            | 触发时机                                 |
| ------------------------------- | ---------------------------------------- |
| `CHATCOMPLETION_MODEL_CHANGED`  | 模型 select 变更后                       |
| `CHATCOMPLETION_SOURCE_CHANGED` | chat completion source（provider）变更后 |
| `MAIN_API_CHANGED`              | 主 API 类型切换后                        |

### 选定方案

**通过 DOM select trigger 切换模型**（最安全，触发完整联动逻辑）。

### 代码片段

```ts
const ctx = SillyTavern.getContext();

// 读取
const currentModel = ctx.getChatCompletionModel();
const currentSource = ctx.chatCompletionSettings.chat_completion_source;

// 切换模型（以 OpenAI 为例）
// 1. 修改设置对象
ctx.chatCompletionSettings.openai_model = 'gpt-4o';
// 2. 同步 DOM 并触发联动
$('#model_openai_select').val('gpt-4o').trigger('change');

// 或者：切换 provider（主 API 级别）
// changeMainAPI 是导出函数但不在 getContext() 中
// 用 DOM 方式：
$('#main_api').val('openai').trigger('change');
$('#chat_completion_source').val('openai').trigger('change');
```

### 结论

- 读取模型：`getContext().getChatCompletionModel()` ✅
- 切换模型：**无直接 API**，通过 DOM select `.val(x).trigger('change')` 是最可靠路径。oai_settings 对象通过 getContext() 可读写，但需要触发 change 事件驱动联动。

---

## Q7: settings.json 写入

### 探测方法

扫描 `script.js` 中 `saveSettings` / `saveSettingsDebounced` 实现 + REST 端点。

### ST 实际行为

1. **`saveSettingsDebounced()`** — 通过 `getContext()` 暴露。防抖封装的 `saveSettings()`。

```js
// script.js:583
export const saveSettingsDebounced = debounce(
  (loopCounter = 0) => saveSettings(loopCounter),
  DEFAULT_SAVE_EDIT_TIMEOUT // 通常 2000ms
);
```

2. **`saveSettings()`** 内部流程：

```js
// script.js:9073
export async function saveSettings(loopCounter = 0) {
  if (!settingsReady) {
    saveSettingsDebounced(); // 重试
    return;
  }
  const payload = {
    firstRun,
    accountStorage,
    currentVersion,
    username: name1,
    active_character,
    active_group,
    user_avatar,
    amount_gen,
    max_context,
    main_api,
    world_info_settings,
    textgenerationwebui_settings,
    swipes,
    horde_settings,
    power_user,
    extension_settings,
    tags,
    tag_map,
    nai_settings,
    kai_settings,
    oai_settings,
    background,
    proxies,
    selected_proxy,
  };
  const result = await fetch('/api/settings/save', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify(payload),
  });
  if (result.ok) {
    settings = payload;
    await eventSource.emit(event_types.SETTINGS_UPDATED);
  }
}
```

3. REST 端点 `POST /api/settings/save` — 服务端将 payload 写入 `settings.json`。

4. **SETTINGS_UPDATED 事件** — 保存成功后 emit。

### 选定方案

**使用 `getContext().saveSettingsDebounced()`** 触发保存。这是 ST 的标准路径，通过内存状态机序列化整个 settings 对象到文件，不会绕过任何状态。

工作流程：

1. 修改内存中的设置对象（如 `ctx.chatCompletionSettings.xxx = 'yyy'`）
2. 调用 `ctx.saveSettingsDebounced()` 触发持久化
3. 监听 `SETTINGS_UPDATED` 确认保存完成

### 代码片段

```ts
const ctx = SillyTavern.getContext();

// 修改设置（示例：修改 extension_settings）
ctx.extensionSettings.myExtension = { key: 'value' };

// 触发保存 → 内部自动序列化到 /api/settings/save → 写入 settings.json
ctx.saveSettingsDebounced();

// 监听保存完成
ctx.eventSource.on(ctx.eventTypes.SETTINGS_UPDATED, () => {
  console.log('Settings persisted to settings.json');
});
```

### 结论

**`saveSettingsDebounced()` 通过 getContext() 公开** ✅。这是唯一正确的保存路径，避免直写文件绕过状态机。

---

## 汇总决策表

| #   | 问题          | 结论                                                                              | 可靠度                | bridge action 设计建议                    |
| --- | ------------- | --------------------------------------------------------------------------------- | --------------------- | ----------------------------------------- |
| Q1  | 启动就绪信号  | `eventSource.on(APP_READY)` + barrier 自动重放                                    | ✅ 100%               | bridge 握手在 APP_READY 回调内启动        |
| Q2  | 切角色        | `getContext().selectCharacterById(index, { switchMenu: false })`                  | ✅ 公开 API           | action: `SELECT_CHARACTER` → 调此函数     |
| Q3  | 切 chat       | `getContext().openCharacterChat(fileNameNoExt)`                                   | ✅ 公开 API           | action: `OPEN_CHAT` → 调此函数            |
| Q4  | chat 列表事件 | 无 `chats_loaded`；用 `CHAT_CHANGED` + REST 拉取 + `CREATED/DELETED/RENAMED` 监听 | ⚠️ 组合方案           | event: 转发 CHAT_CHANGED；列表数据走 REST |
| Q5  | 删除 chat     | REST `/api/chats/delete`                                                          | ⚠️ 未在 getContext 中 | action: `DELETE_CHAT` → REST 调用         |
| Q5  | 重命名 chat   | `getContext().renameChat()`                                                       | ✅ 公开 API           | action: `RENAME_CHAT` → 调此函数          |
| Q5  | 置顶 chat     | **ST 无此功能**                                                                   | ❌ 无解               | 平台侧 Supabase 自维护 pin 标记           |
| Q6  | 模型切换      | DOM select `.val().trigger('change')`                                             | ⚠️ DOM 路径           | action: `CHANGE_MODEL` → DOM trigger      |
| Q6  | 读取模型      | `getContext().getChatCompletionModel()`                                           | ✅ 公开 API           | mirror state 包含 currentModel            |
| Q7  | 保存 settings | `getContext().saveSettingsDebounced()`                                            | ✅ 公开 API           | 每个改设置的 action 末尾调此函数          |

---

## 附录：getContext() 中与 bridge 直接相关的属性清单

```
// 状态读取
characters          → 角色列表数组
chat                → 当前 chat 消息数组
characterId         → 当前角色索引 (this_chid)
groupId             → 当前群组 ID
chatId              → 当前 chat ID
getCurrentChatId()  → 当前 chat 文件名
mainApi             → 当前主 API 类型
chatCompletionSettings → oai_settings 完整对象
getChatCompletionModel() → 当前模型名

// 动作
selectCharacterById(id, opts)  → 切角色
openCharacterChat(fileName)    → 切 chat
renameChat(old, new)           → 重命名 chat
reloadCurrentChat()            → 重新加载当前 chat
saveSettingsDebounced()        → 触发 settings.json 持久化
getRequestHeaders()            → 获取认证头（用于 REST 调用）

// 事件系统
eventSource         → EventEmitter 实例
eventTypes          → 事件常量映射对象

// 相关事件
APP_READY                      → 启动就绪（barrier）
APP_INITIALIZED                → 初始化完成（barrier）
CHAT_CHANGED                   → chat 切换完成
CHAT_LOADED                    → chat 加载完成
CHAT_CREATED                   → 新建 chat
CHAT_DELETED                   → 删除 chat
CHAT_RENAMED                   → 重命名 chat
SETTINGS_UPDATED               → settings 保存完成
CHATCOMPLETION_MODEL_CHANGED   → 模型变更
CHATCOMPLETION_SOURCE_CHANGED  → provider 变更
MAIN_API_CHANGED               → 主 API 变更
```

---

## 附录：spike 期间 REST 端点清单

| 端点                    | 方法                                                         | 用途               |
| ----------------------- | ------------------------------------------------------------ | ------------------ |
| `/api/characters/chats` | POST `{ avatar_url }`                                        | 获取角色 chat 列表 |
| `/api/chats/delete`     | POST `{ chatfile, avatar_url }`                              | 删除指定 chat      |
| `/api/chats/rename`     | POST `{ is_group, avatar_url, original_file, renamed_file }` | 重命名 chat        |
| `/api/settings/save`    | POST `{ ...settings }`                                       | 保存 settings.json |

---

---

## Q8: 生成事件探测

### 探测方法

扫描 `scripts/events.js` 所有 `GENERATION_*` / `MESSAGE_*` / `STREAM_*` / `GENERATE_*` 事件常量 + 追踪 `script.js` 中每个事件的 `emit` 调用位置与参数。

### ST 实际行为

#### 8.1 完整事件常量清单

**GENERATION / GENERATE 系列：**

| 常量名                            | 字符串值                            | 定义位置     |
| --------------------------------- | ----------------------------------- | ------------ |
| `GENERATION_STARTED`              | `'generation_started'`              | events.js:23 |
| `GENERATION_STOPPED`              | `'generation_stopped'`              | events.js:24 |
| `GENERATION_ENDED`                | `'generation_ended'`                | events.js:25 |
| `GENERATION_AFTER_COMMANDS`       | `'GENERATION_AFTER_COMMANDS'`       | events.js:22 |
| `GENERATE_BEFORE_COMBINE_PROMPTS` | `'generate_before_combine_prompts'` | events.js:56 |
| `GENERATE_AFTER_COMBINE_PROMPTS`  | `'generate_after_combine_prompts'`  | events.js:57 |
| `GENERATE_AFTER_DATA`             | `'generate_after_data'`             | events.js:58 |

**MESSAGE 系列：**

| 常量名                      | 字符串值                      | 定义位置     |
| --------------------------- | ----------------------------- | ------------ |
| `MESSAGE_SENT`              | `'message_sent'`              | events.js:8  |
| `MESSAGE_RECEIVED`          | `'message_received'`          | events.js:9  |
| `MESSAGE_EDITED`            | `'message_edited'`            | events.js:10 |
| `MESSAGE_DELETED`           | `'message_deleted'`           | events.js:11 |
| `MESSAGE_UPDATED`           | `'message_updated'`           | events.js:12 |
| `MESSAGE_SWIPED`            | `'message_swiped'`            | events.js:7  |
| `MESSAGE_FILE_EMBEDDED`     | `'message_file_embedded'`     | events.js:13 |
| `MESSAGE_REASONING_EDITED`  | `'message_reasoning_edited'`  | events.js:14 |
| `MESSAGE_REASONING_DELETED` | `'message_reasoning_deleted'` | events.js:15 |
| `MESSAGE_SWIPE_DELETED`     | `'message_swipe_deleted'`     | events.js:16 |

**STREAM 系列：**

| 常量名                         | 字符串值                  | 定义位置                     |
| ------------------------------ | ------------------------- | ---------------------------- |
| `STREAM_TOKEN_RECEIVED`        | `'stream_token_received'` | events.js:74                 |
| `SMOOTH_STREAM_TOKEN_RECEIVED` | `'stream_token_received'` | events.js:73（已废弃，别名） |
| `STREAM_REASONING_DONE`        | `'stream_reasoning_done'` | events.js:75                 |

**渲染系列（生成流程关联）：**

| 常量名                       | 字符串值                       | 定义位置     |
| ---------------------------- | ------------------------------ | ------------ |
| `USER_MESSAGE_RENDERED`      | `'user_message_rendered'`      | events.js:48 |
| `CHARACTER_MESSAGE_RENDERED` | `'character_message_rendered'` | events.js:49 |
| `IMPERSONATE_READY`          | `'impersonate_ready'`          | events.js:18 |

#### 8.2 生成流程 emit 顺序

追踪 `script.js` 中一次完整的"用户发送消息 → LLM 生成回复"流程，事件 emit 顺序如下：

```
┌─ 用户发送阶段 ─────────────────────────────────────┐
│ 1. MESSAGE_SENT         (chat_id: number)           │ script.js:6712/6719
│ 2. USER_MESSAGE_RENDERED(chat_id: number)           │ script.js:6714/6721
└─────────────────────────────────────────────────────┘
┌─ 生成准备阶段 ─────────────────────────────────────┐
│ 3. GENERATION_STARTED   (type, options, dryRun)     │ script.js:4762
│    ↳ 每次都触发，含被 slash 命令中止的情况            │
│ 4. GENERATION_AFTER_COMMANDS (type, options)        │ script.js:4798
│    ↳ 仅在 slash 命令未中止时触发                     │
└─────────────────────────────────────────────────────┘
┌─ Prompt 组装阶段 ──────────────────────────────────┐
│ 5. GENERATE_BEFORE_COMBINE_PROMPTS (data)          │ script.js:5872
│ 6. GENERATE_AFTER_COMBINE_PROMPTS  ({prompt,dryRun})│ script.js:5881
│ 7. GENERATE_AFTER_DATA  (generate_data, dryRun)    │ script.js:5988
└─────────────────────────────────────────────────────┘
┌─ 流式接收阶段（仅 streaming 模式）────────────────┐
│ 8. STREAM_TOKEN_RECEIVED(text: string)  ×N         │ script.js:4243
│    ↳ 每收到一个 token 触发一次，参数为当前累积文本    │
│ 9. STREAM_REASONING_DONE(reasoning, duration, msgId)│ reasoning.js:592
│    ↳ 仅在模型输出 reasoning/thinking 时触发          │
└─────────────────────────────────────────────────────┘
┌─ 生成完成阶段 ─────────────────────────────────────┐
│10. MESSAGE_RECEIVED     (chat_id, type)             │ script.js:4139/7636
│    ↳ type = 'normal'|'swipe'|'continue'|'first_message'│
│11. CHARACTER_MESSAGE_RENDERED(chat_id, type)        │ script.js:4140/7639
│12. GENERATION_ENDED     (chat.length)               │ script.js:3856
│    ↳ stop 按钮隐藏时触发                             │
└─────────────────────────────────────────────────────┘
┌─ 异常/中止 ────────────────────────────────────────┐
│ *. GENERATION_STOPPED   (无参数)                    │ script.js:6390
│    ↳ 用户手动停止或 API 调用 stopGeneration() 时触发 │
└─────────────────────────────────────────────────────┘
```

#### 8.3 各事件参数 schema

```ts
// GENERATION_STARTED
(type: string, options: {
  automatic_trigger: boolean;
  force_name2: string;
  quiet_prompt: string;
  quietToLoud: boolean;
  skipWIAN: boolean;
  force_chid: number;
  signal: AbortSignal;
  quietImage: string;
}, dryRun: boolean)

// GENERATION_AFTER_COMMANDS — 同 GENERATION_STARTED，无 dryRun
(type: string, options: { ... })

// GENERATE_BEFORE_COMBINE_PROMPTS
(data: { combinedPrompt?: string; ... })  // 可修改 combinedPrompt 拦截 prompt

// GENERATE_AFTER_COMBINE_PROMPTS
(eventData: { prompt: string; dryRun: boolean })  // 可修改 prompt

// GENERATE_AFTER_DATA
(generate_data: object, dryRun: boolean)

// STREAM_TOKEN_RECEIVED
(text: string)  // 当前累积的完整文本（非增量 delta）

// STREAM_REASONING_DONE
(reasoning: string, duration: number, messageId: number)

// MESSAGE_SENT
(chat_id: number)

// USER_MESSAGE_RENDERED
(chat_id: number)

// MESSAGE_RECEIVED
(chat_id: number, type: 'normal'|'swipe'|'continue'|'first_message'|string)

// CHARACTER_MESSAGE_RENDERED
(chat_id: number, type: string)

// GENERATION_ENDED
(chatLength: number)

// GENERATION_STOPPED
()  // 无参数

// IMPERSONATE_READY
(text: string)
```

#### 8.4 关键注意点

1. **`STREAM_TOKEN_RECEIVED` 的参数是累积文本**，不是增量 delta。每次 emit 包含从生成开始到当前的完整文本。
2. **`MESSAGE_RECEIVED` 在 streaming 完成后也会 emit**，但在 streaming 中间不触发（由 `!fromStreaming` 守卫）。对于 streaming 完成后的 emit，走的是 `StreamingProcessor.onFinishStreaming()` 路径（script.js:4139）。
3. **`GENERATION_STARTED` 总是触发**，即使后续被 slash 命令中止。`GENERATION_AFTER_COMMANDS` 仅在未被中止时触发。
4. **`GENERATION_ENDED` 与 `GENERATION_STOPPED` 互斥**：正常完成触发 ENDED，手动停止触发 STOPPED + ENDED。
5. **Impersonate 模式** 不 emit `MESSAGE_RECEIVED`，而是 emit `IMPERSONATE_READY`。

### 选定方案

bridge 需关注的核心事件子集：

| bridge event           | ST 事件                 | 用途                             |
| ---------------------- | ----------------------- | -------------------------------- |
| `generation:started`   | `GENERATION_STARTED`    | 通知平台生成开始（显示 loading） |
| `generation:token`     | `STREAM_TOKEN_RECEIVED` | 实时转发 streaming 文本          |
| `generation:completed` | `MESSAGE_RECEIVED`      | 通知平台生成完成，含最终消息 ID  |
| `generation:stopped`   | `GENERATION_STOPPED`    | 通知平台用户中止了生成           |
| `generation:ended`     | `GENERATION_ENDED`      | 生成流程结束（含正常和中止）     |

### 代码片段

```ts
const ctx = SillyTavern.getContext();
const et = ctx.eventTypes;

ctx.eventSource.on(et.GENERATION_STARTED, (type, options, dryRun) => {
  if (dryRun) return;
  bridge.emit('generation:started', { type });
});

ctx.eventSource.on(et.STREAM_TOKEN_RECEIVED, (text) => {
  bridge.emit('generation:token', { text });
});

ctx.eventSource.on(et.MESSAGE_RECEIVED, (chatId, type) => {
  const msg = ctx.chat[chatId];
  bridge.emit('generation:completed', { chatId, type, message: msg });
});

ctx.eventSource.on(et.GENERATION_STOPPED, () => {
  bridge.emit('generation:stopped', {});
});
```

### 结论

**生成流程有完整的事件覆盖**，从 `GENERATION_STARTED` 到 `MESSAGE_RECEIVED` / `GENERATION_ENDED` 全程可监听。Streaming 通过 `STREAM_TOKEN_RECEIVED` 提供实时文本（累积式，非增量）。所有事件均可通过 `getContext().eventSource.on()` 订阅。

---

## Q9: 新建 chat API 探测

### 探测方法

扫描 `script.js` 中 `doNewChat` 导出 + `st-context.js` 暴露清单 + `power-user.js` slash 命令注册 + `#option_start_new_chat` DOM 处理。

### ST 实际行为

#### 9.1 `doNewChat()` 函数

```js
// script.js:11891 — 公开导出但 **未通过 getContext() 暴露**
export async function doNewChat({ deleteCurrentChat = false } = {}) {
  if ((!selected_group && this_chid == undefined) || menu_type == 'create') return;

  await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
  await clearChat({ clearData: true });

  // 非群组场景
  chat_metadata = {};
  characters[this_chid].chat = `${name2} - ${humanizedDateTime()}`;
  $('#selected_chat_pole').val(characters[this_chid].chat);
  await getChat(); // 加载新 chat（空 → 首条消息）
  await createOrEditCharacter(new CustomEvent('newChat')); // 持久化角色的 chat 指针
  if (deleteCurrentChat) await delChat(chat_file_for_del + '.jsonl');
}
```

内部流程：

1. 等待 chat 保存完成
2. 清空当前 chat
3. 设新 chat 名 = `角色名 - 时间戳`
4. `getChat()` → 创建空 chat → `getChatResult()` → emit `CHAT_CHANGED` + `CHAT_CREATED`
5. `createOrEditCharacter()` → POST `/api/characters/edit` 持久化角色 chat 指针

#### 9.2 `/newchat` slash 命令 ✅ 最优路径

```js
// power-user.js:4462
SlashCommandParser.addCommandObject(
  SlashCommand.fromProps({
    name: 'newchat',
    callback: async (args, _) => {
      await doNewChat({ deleteCurrentChat: isTrueBoolean(args.delete) });
      return '';
    },
    namedArgumentList: [
      SlashCommandNamedArgument.fromProps({
        name: 'delete',
        description: 'delete the current chat',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
        defaultValue: 'false',
      }),
    ],
    helpString: 'Starts a new chat for the current character/group.',
  })
);
```

通过 `getContext().executeSlashCommandsWithOptions('/newchat')` 调用，**无需确认弹窗**。

#### 9.3 DOM 触发路径 ⚠️ 有确认弹窗

```js
// script.js:13035
} else if (id == 'option_start_new_chat') {
  const result = await Popup.show.confirm(t`Start new chat?`, ...);
  if (!result) return;
  await doNewChat({ deleteCurrentChat });
}
```

`$('#option_start_new_chat').trigger('click')` 会弹出确认对话框，不适合程序化调用。

#### 9.4 直接复制 doNewChat 逻辑（不推荐）

理论上可以通过 `getContext()` 暴露的 `clearChat` + `characters` 引用 + `reloadCurrentChat` 拼凑，但缺少 `createOrEditCharacter()` 来持久化角色 chat 指针，会导致刷新后 chat 丢失。

### 选定方案

**使用 slash 命令 `/newchat`**，通过 `getContext().executeSlashCommandsWithOptions()` 调用。

### 代码片段

```ts
const ctx = SillyTavern.getContext();

// 新建 chat（保留当前 chat）
await ctx.executeSlashCommandsWithOptions('/newchat');

// 新建 chat 并删除当前 chat
await ctx.executeSlashCommandsWithOptions('/newchat delete=true');

// 监听新建完成
ctx.eventSource.on(ctx.eventTypes.CHAT_CREATED, () => {
  console.log('New chat created, chatId:', ctx.getCurrentChatId());
});
```

### 结论

- **`doNewChat()` 存在但未通过 getContext() 暴露** ⚠️
- **最优路径：slash 命令 `/newchat`**，通过 `executeSlashCommandsWithOptions` 调用 ✅
- 避免 DOM 触发 `#option_start_new_chat`（会弹确认框）
- 新建完成后 `CHAT_CREATED` 事件会 emit

---

## Q10: selectCharacterById 后 settings 持久化验证

### 探测方法

追踪 `selectCharacterById` → `setCharacterId` → `getChat` 全链路，检查是否调用 `setActiveCharacter()` 或 `saveSettingsDebounced()`。额外扫描 `RossAscends-mods.js` 中 `.character_select` click 事件处理器。

### ST 实际行为

#### 10.1 `selectCharacterById` 内部不保存 settings

```js
// script.js:998
export async function selectCharacterById(id, { switchMenu = true } = {}) {
  // ...
  setCharacterId(id); // ← 仅设 this_chid，不设 active_character
  chat_metadata = {};
  await getChat(); // ← 加载 chat，内部无 saveSettingsDebounced
}
```

`setCharacterId()` (script.js:8089) 只设置 `this_chid` 变量，**不触及 `active_character`**，也不调 `saveSettingsDebounced()`。

`getChat()` → `getChatResult()` 内部：

- 调 `select_selected_character(this_chid)` — 纯 UI 更新，不保存 settings
- emit `CHAT_CHANGED` — 不触发 settings 保存

#### 10.2 DOM click 场景有独立保存逻辑

```js
// RossAscends-mods.js:932
$(document).on('click', '.character_select', function () {
  const characterId = $(this).attr('data-chid');
  setActiveCharacter(characterId); // ← 设 active_character
  setActiveGroup(null);
  saveSettingsDebounced(); // ← 触发持久化
});
```

当用户在 UI 上**点击**角色时，`RossAscends-mods.js` 的 click handler 会额外调用 `setActiveCharacter()` + `saveSettingsDebounced()`。但这是**独立的 DOM 事件处理器**，不在 `selectCharacterById` 内部。

#### 10.3 结论链路对比

| 场景                             | setCharacterId               | setActiveCharacter                      | saveSettingsDebounced                   | settings.json 更新 |
| -------------------------------- | ---------------------------- | --------------------------------------- | --------------------------------------- | ------------------ |
| UI 点击角色                      | ✅ (via selectCharacterById) | ✅ (via RossAscends-mods click handler) | ✅ (via RossAscends-mods click handler) | ✅                 |
| API 调用 `selectCharacterById()` | ✅                           | ❌                                      | ❌                                      | ❌                 |

#### 10.4 settings.json 中的 `active_character` 字段

`active_character` 存储在 `settings.json` 中（script.js:9098），用于页面刷新后自动重新选择上次活跃角色。如果不更新此字段，刷新后不会自动回到 API 切换的角色。

### 选定方案

**`selectCharacterById()` 不自动持久化。** 调用后需手动保存：

```ts
const ctx = SillyTavern.getContext();
await ctx.selectCharacterById(targetIndex, { switchMenu: false });

// 必须手动持久化 active_character
// setActiveCharacter 未通过 getContext() 暴露，但 saveSettingsDebounced 已暴露
// 方案：直接调 saveSettingsDebounced()（settings 对象包含 active_character 引用）
ctx.saveSettingsDebounced();
```

**注意**：`setActiveCharacter()` 未通过 `getContext()` 暴露。但 `active_character` 是 `settings` payload 的一个字段（script.js:9098），`saveSettingsDebounced()` 会序列化当前内存中的 `active_character` 值。问题是：如果不调 `setActiveCharacter()`，`active_character` 变量仍是旧值，即使调 `saveSettingsDebounced()` 也会把旧值写入。

**完整方案**（需使用 slash 命令辅助）：

```ts
const ctx = SillyTavern.getContext();
const targetAvatar = ctx.characters[targetIndex]?.avatar;
await ctx.selectCharacterById(targetIndex, { switchMenu: false });

// 通过 slash 命令 /go 切换角色（内部调用 setActiveCharacter + saveSettingsDebounced）
// 或直接操纵 DOM:
// 但 /go 命令（slash-commands.js:5719-5724）也调了 setActiveCharacter
await ctx.executeSlashCommandsWithOptions(`/go ${ctx.characters[targetIndex]?.name}`);
```

或者在 bridge 层面，在 `selectCharacterById` 之后始终调用 `saveSettingsDebounced()`，接受 `active_character` 可能不是最新值的风险（功能上不影响当前会话，仅影响刷新后的自动恢复）。

### 代码片段

```ts
const ctx = SillyTavern.getContext();

// 方案 A：selectCharacterById + 手动 save（active_character 不更新，刷新后可能不自动恢复）
await ctx.selectCharacterById(targetIndex, { switchMenu: false });
ctx.saveSettingsDebounced();

// 方案 B（推荐）：使用 /go 命令（完整路径：setActiveCharacter + openChat + saveSettingsDebounced）
await ctx.executeSlashCommandsWithOptions(`/go ${characterName}`);

// 方案 C：selectCharacterById 后通过 DOM 模拟 click 触发 RossAscends-mods 的保存逻辑
await ctx.selectCharacterById(targetIndex, { switchMenu: false });
$(`.character_select[data-chid="${targetIndex}"]`).trigger('click');
// ⚠️ 会再次调 selectCharacterById，有重复加载风险
```

### 结论

**`selectCharacterById()` 不自动持久化** — 这是明确的"否"。`active_character` 不会更新，`settings.json` 不会写入。

bridge 设计建议：

- 如果只是临时切换角色（不关心刷新恢复），调 `selectCharacterById` 即可
- 如果需要持久化（刷新后自动恢复），使用 `/go` slash 命令或在 `selectCharacterById` 后额外调 `saveSettingsDebounced()`

---

## Q11: 获取当前预设名 API 路径

### 探测方法

扫读 `preset-manager.js` 与 `st-context.js`，确认 preset manager 的导出边界、注册方式，以及扩展侧通过 `getContext()` 可访问的公开属性。

### ST 实际行为

1. `preset-manager.js` 公开导出 `getPresetManager(apiId = '')`。不传 `apiId` 时，会使用当前 `main_api`；其中 `koboldhorde` 会归一到 `kobold`。

```js
export function getPresetManager(apiId = '') {
  if (apiId === 'koboldhorde') {
    apiId = 'kobold';
  }
  if (!apiId) {
    apiId = main_api == 'koboldhorde' ? 'kobold' : main_api;
  }

  if (!Object.keys(presetManagers).includes(apiId)) {
    return null;
  }

  return presetManagers[apiId];
}
```

2. `PresetManager` 实例提供 `getSelectedPresetName()`，直接读取当前 select 的选中 option 文本。

```js
getSelectedPresetName() {
  return $(this.select).find('option:selected').text();
}
```

3. `st-context.js` 将 `getPresetManager` 放入 `getContext()` 返回对象，因此扩展侧可通过官方入口访问，不需要私有 import 或 DOM selector。

```js
export function getContext() {
  return {
    mainApi: main_api,
    getPresetManager,
    // ...
  };
}
```

4. preset manager 由 `select[data-preset-manager-for]` 注册，已覆盖主 LLM 预设与高级格式模板：`openai`、`textgenerationwebui`、`kobold`、`novel`、`context`、`instruct`、`sysprompt`、`reasoning` 等。

### 选定方案

**使用 `getContext().getPresetManager(apiId?)?.getSelectedPresetName()`。**

```ts
const ctx = SillyTavern.getContext();

// 当前 main_api 对应的生成预设名
const currentPresetName = ctx.getPresetManager()?.getSelectedPresetName() ?? null;

// 指定 API / 模板的预设名
const chatCompletionPresetName = ctx.getPresetManager('openai')?.getSelectedPresetName() ?? null;
const textCompletionPresetName =
  ctx.getPresetManager('textgenerationwebui')?.getSelectedPresetName() ?? null;
const instructTemplateName = ctx.getPresetManager('instruct')?.getSelectedPresetName() ?? null;
const contextTemplateName = ctx.getPresetManager('context')?.getSelectedPresetName() ?? null;
```

### 结论

**当前预设名有公开 API 路径** ✅：`SillyTavern.getContext().getPresetManager()?.getSelectedPresetName()`。

bridge 设计建议：

- mirror state 可新增 `currentPresetName`
- 若需要区分 Chat Completion / Text Completion / Instruct / Context 等模板，传显式 `apiId`
- `getPresetManager()` 可能返回 `null`，bridge 侧需按 `null` 处理，不应 fallback 到 DOM selector

---

## 汇总决策表（更新）

| #   | 问题          | 结论                                                                              | 可靠度                | bridge action 设计建议                                          |
| --- | ------------- | --------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| Q1  | 启动就绪信号  | `eventSource.on(APP_READY)` + barrier 自动重放                                    | ✅ 100%               | bridge 握手在 APP_READY 回调内启动                              |
| Q2  | 切角色        | `getContext().selectCharacterById(index, { switchMenu: false })`                  | ✅ 公开 API           | action: `SELECT_CHARACTER` → 调此函数                           |
| Q3  | 切 chat       | `getContext().openCharacterChat(fileNameNoExt)`                                   | ✅ 公开 API           | action: `OPEN_CHAT` → 调此函数                                  |
| Q4  | chat 列表事件 | 无 `chats_loaded`；用 `CHAT_CHANGED` + REST 拉取 + `CREATED/DELETED/RENAMED` 监听 | ⚠️ 组合方案           | event: 转发 CHAT_CHANGED；列表数据走 REST                       |
| Q5  | 删除 chat     | REST `/api/chats/delete`                                                          | ⚠️ 未在 getContext 中 | action: `DELETE_CHAT` → REST 调用                               |
| Q5  | 重命名 chat   | `getContext().renameChat()`                                                       | ✅ 公开 API           | action: `RENAME_CHAT` → 调此函数                                |
| Q5  | 置顶 chat     | **ST 无此功能**                                                                   | ❌ 无解               | 平台侧 Supabase 自维护 pin 标记                                 |
| Q6  | 模型切换      | DOM select `.val().trigger('change')`                                             | ⚠️ DOM 路径           | action: `CHANGE_MODEL` → DOM trigger                            |
| Q6  | 读取模型      | `getContext().getChatCompletionModel()`                                           | ✅ 公开 API           | mirror state 包含 currentModel                                  |
| Q7  | 保存 settings | `getContext().saveSettingsDebounced()`                                            | ✅ 公开 API           | 每个改设置的 action 末尾调此函数                                |
| Q8  | 生成事件      | 全链路事件覆盖：STARTED→TOKEN→RECEIVED→ENDED                                      | ✅ 完整               | event: 转发 generation:\* 系列                                  |
| Q9  | 新建 chat     | slash 命令 `/newchat` via `executeSlashCommandsWithOptions`                       | ✅ 间接 API           | action: `NEW_CHAT` → `/newchat` 命令                            |
| Q10 | 切角色持久化  | `selectCharacterById` **不自动持久化**                                            | ✅ 明确否             | 切角色后需额外调 `saveSettingsDebounced()` 或用 `/go`           |
| Q11 | 当前预设名    | `getContext().getPresetManager()?.getSelectedPresetName()`                        | ✅ 公开 API           | mirror state 新增 `currentPresetName`，需要分类时传显式 `apiId` |

---

## 附录：getContext() 中与 bridge 直接相关的属性清单（更新）

```
// 状态读取
characters          → 角色列表数组
chat                → 当前 chat 消息数组
characterId         → 当前角色索引 (this_chid)
groupId             → 当前群组 ID
chatId              → 当前 chat ID
getCurrentChatId()  → 当前 chat 文件名
mainApi             → 当前主 API 类型
chatCompletionSettings → oai_settings 完整对象
getChatCompletionModel() → 当前模型名
getPresetManager(apiId?) → 获取 preset manager；可读当前预设名

// 动作
selectCharacterById(id, opts)  → 切角色（不自动持久化！）
openCharacterChat(fileName)    → 切 chat
renameChat(old, new)           → 重命名 chat
reloadCurrentChat()            → 重新加载当前 chat
saveSettingsDebounced()        → 触发 settings.json 持久化
getRequestHeaders()            → 获取认证头（用于 REST 调用）
executeSlashCommandsWithOptions(cmd) → 执行 slash 命令
clearChat(opts)                → 清空当前 chat
generate(type, opts)           → 触发生成
stopGeneration()               → 停止生成

// 事件系统
eventSource         → EventEmitter 实例
eventTypes          → 事件常量映射对象

// 相关事件（Q1-Q7）
APP_READY                      → 启动就绪（barrier）
APP_INITIALIZED                → 初始化完成（barrier）
CHAT_CHANGED                   → chat 切换完成
CHAT_LOADED                    → chat 加载完成
CHAT_CREATED                   → 新建 chat
CHAT_DELETED                   → 删除 chat
CHAT_RENAMED                   → 重命名 chat
SETTINGS_UPDATED               → settings 保存完成
CHATCOMPLETION_MODEL_CHANGED   → 模型变更
CHATCOMPLETION_SOURCE_CHANGED  → provider 变更
MAIN_API_CHANGED               → 主 API 变更

// 相关事件（Q8 生成流程）
GENERATION_STARTED             → 生成开始
GENERATION_AFTER_COMMANDS      → 命令处理后，生成继续
GENERATION_STOPPED             → 用户中止生成
GENERATION_ENDED               → 生成流程结束
GENERATE_BEFORE_COMBINE_PROMPTS → prompt 组装前（可拦截）
GENERATE_AFTER_COMBINE_PROMPTS  → prompt 组装后（可修改）
GENERATE_AFTER_DATA            → 生成数据就绪
MESSAGE_SENT                   → 用户消息发送
MESSAGE_RECEIVED               → AI 回复接收完成
STREAM_TOKEN_RECEIVED          → 流式 token 接收（累积文本）
STREAM_REASONING_DONE          → reasoning/thinking 完成
USER_MESSAGE_RENDERED          → 用户消息渲染完成
CHARACTER_MESSAGE_RENDERED     → AI 消息渲染完成
IMPERSONATE_READY              → impersonate 完成
```

---

## 附录：spike 期间 REST 端点清单

| 端点                    | 方法                                                         | 用途               |
| ----------------------- | ------------------------------------------------------------ | ------------------ |
| `/api/characters/chats` | POST `{ avatar_url }`                                        | 获取角色 chat 列表 |
| `/api/chats/delete`     | POST `{ chatfile, avatar_url }`                              | 删除指定 chat      |
| `/api/chats/rename`     | POST `{ is_group, avatar_url, original_file, renamed_file }` | 重命名 chat        |
| `/api/settings/save`    | POST `{ ...settings }`                                       | 保存 settings.json |

---

## 附录：spike 期间 Slash 命令清单（Q9 新增）

| 命令          | 参数                 | 用途                 | 内部调用                                     |
| ------------- | -------------------- | -------------------- | -------------------------------------------- |
| `/newchat`    | `delete=true\|false` | 新建 chat            | `doNewChat()`                                |
| `/go`         | `characterName`      | 切换角色（含持久化） | `selectCharacterById` + `setActiveCharacter` |
| `/renamechat` | `newName`            | 重命名当前 chat      | `renameChat()`                               |

---

_本报告可直接作为阶段 3 bridge-protocol actions/events 设计依据。_
