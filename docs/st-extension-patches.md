# st-extension 侧的 vendor 兼容补丁

> 架构铁律 1：`vendor/sillytavern` 只读。ST 在「被嵌入 iframe + 挂在 `/tavern` 子路径」
> 这一非原生部署形态下暴露的行为缺陷，一律从 `packages/st-extension` 侧修复，vendor 零改。
>
> 所有补丁在 `src/entry.ts` 的 `init()` 内安装。本文记录每个补丁的根因、修复方式与验证。

---

## 1. autocomplete-guard（resize 报错）

- **文件**：`src/patches/autocomplete-guard.ts`
- **现象**：`Uncaught Error: cannot call methods on autocomplete prior to initialization; attempted to call method 'widget'`（`power-user.js:3457`）。
- **根因**：iframe 环境中 `window.resize` 早于 jQuery UI autocomplete 初始化触发，`power-user.js` 的 `adjustAutocompleteDebounced` 对未初始化元素调用 `$(el).autocomplete('widget')`，jQuery UI widget bridge 抛异常。
- **修复**：包装 `$.fn.autocomplete`，元素未初始化时 `widget` 返回一个 `display:none` 的游离元素（使 `.autocomplete('widget')[0].style.display !== 'none'` 安全求值为 false），其他方法 no-op 保持链式。
- **历史**：曾被错误地直接改 `vendor/.../power-user.js`（违反铁律 1），后回退 vendor、迁移至此补丁。

---

## 2. tabs-base-guard（对话页整体不渲染 / 发送按钮消失 / 消息发不出）

- **文件**：`src/patches/tabs-base-guard.ts`
- **现象**：进入对话页后 ST 区域黑屏；输入框看不到发送按钮；打字回车后文字留在输入框、无用户气泡，但偶尔出现「回复」（实为角色开场白）。
- **根因（链路）**：
  1. ST `index.html` 含 `<base href="/">`，解析基址为 `http://host/`；但本平台经 Next rewrite 把 ST 挂在 `http://host/tavern` 提供服务。
  2. jQuery UI Tabs（背景选择器 `#bg_tabs`）判定 tab 是否「本地锚点」的逻辑是 `anchor.href(去hash) === location.href(去hash)`。受 `<base href="/">` 影响，本地锚点 `#bg_global_tab` 的 `anchor.href` 解析成 `http://host/#bg_global_tab`（基址部分 `http://host/`），与 location `http://host/tavern` 不等 → 被误判为「远程 tab」。
  3. jQuery UI 于是对该 tab 发起 AJAX，把整页（ST 自身）加载进 tab 面板，注入了一份**完整重复的 ST DOM**（出现两个 `#sheld` / `#send_textarea` / `#send_but` / `<title>` / `<base>`）。
  4. 重复节点在 DOM 顺序上靠前且整体 `0×0`（其祖先 `#Backgrounds` 为 `display:none`）。ST 的 `$('#send_textarea')`、`$('#send_but')` 命中隐藏的空副本 → 用户看到/输入的真实节点与 ST 逻辑脱节：发送按钮显隐状态加到错误副本、`Generate()` 读不到输入。
- **为什么 vanilla ST 没事**：原生 ST 跑在根路径 `/`，base 与 location 一致，tab 被正确识别为本地，不触发 AJAX。问题只在「ST 挂到 `/tavern` 子路径 + base 仍是 `/`」的 iframe 嵌入下出现。
- **修复（双保险，覆盖补丁早于/晚于 `bg_tabs` 初始化两种时序）**：
  1. 覆写 `$.ui.tabs.prototype._isLocal`：锚点 hash 指向当前文档存在的元素即判为本地 tab，杜绝把本地锚点当远程 URL 加载。
  2. 修复已被污染的 tabs：检测到重复 ST DOM（同一 id 多份）时，对含整页注入痕迹（`title`/`base`/`#sheld`）的 `.ui-tabs` 执行 `destroy`+重建（jQuery UI 会移除其生成的远程 panel，连带清掉重复 DOM）。
  - 带 200ms 轮询重试，直到重复 DOM 清除或超时。
- **验证**：修复后实测 `#sheld`/`<title>`/`#send_textarea` 均为 1 份；ST 正常渲染、发送按钮可见；输入回车后输入框清空、出现用户气泡、收到真实模型回复（经 LLM 代理）。

---

## 3. regex-autoconfirm（进入对话弹「是否启用角色内置正则」确认框）

- **文件**：`src/patches/regex-autoconfirm.ts`
- **现象**：点角色卡进入对话时，先弹「此角色含有内置正则。你想要启用它们吗？」确认框，需手动点「确定」才进入对话。用户不应感知此弹窗。
- **根因**：ST regex 扩展（`scripts/extensions/regex/index.js`）在 `CHAT_CHANGED` 时执行 `checkCharEmbeddedRegexScripts()`：若当前角色含 SCOPED 正则脚本且 `character.avatar` 不在 `extension_settings.character_allowed_regex` 中，则弹 CONFIRM 弹窗；点「确定」即把 avatar 加入该数组并 reload 当前聊天。
- **修复（等价于自动点「确定」）**：用 `eventSource.makeFirst` 注册一个**先于** ST regex 处理器执行的 `CHAT_CHANGED` 监听，提前把当前角色 avatar 写入 `extension_settings.character_allowed_regex`。这样 ST 处理器运行时 `isScopedScriptsAllowed` 已为 true → 跳过弹窗，且正则按「确定」语义启用。
  - 平台所有角色卡均为运营可信内容，故对所有进入的角色一律自动允许。
  - `makeFirst` 保证抢在 ST 处理器之前，规避事件回调注册顺序竞态，覆盖所有入口（bridge `selectCharacter` / 整页刷新自动载入 / 切换聊天）。
- **验证**：实测本扩展的监听位于 `CHAT_CHANGED` 监听链 index 2，ST regex 处理器在 index 9（本扩展先执行）。移除某含正则角色的 allow 标记后切入该角色，标记被自动重新写入且无弹窗出现。
- **已知未覆盖**：preset 维度的内置正则弹窗（`checkPresetEmbeddedRegexScripts`，由 API/preset 切换触发）暂未处理；如后续 preset 流程触发该弹窗再行补齐。

---

## 4. oai-settings-guard（上下文过小 / 老用户「提示词超过上下文」）

- **文件**：`src/patches/oai-settings-guard.ts`；provision 侧同源逻辑在 `sync-engine/provisioner/merger.ts`（新用户）。
- **现象**：进入对话或发消息时 toastr「必要的提示词超过了上下文大小」；大角色卡（如贺商寒，人设 + 12 条内置正则）必现，小卡也可能偶发。
- **根因**：ST 默认模板 / 老用户 `settings.json` 中 `oai_settings.openai_max_context = 4095` 过小。任意角色组装后的 system + 人设 + 正则 + 历史超过 ~4095 tokens 即触发 ST 警告并截断上下文。非特定角色卡 bug，而是平台级配置未抬升。
- **修复（双轨）**：
  1. **新用户**：`merger.ts` provision 合并时强制 `openai_max_context = 32768`、`max_context_unlocked = true`（与 `custom_url` 同级的强制覆写）。
  2. **老用户**：本扩展在 `APP_READY`（每次 iframe 会话加载 ≈ 登录进 ST）幂等校正上述字段，有变更则 `saveSettingsDebounced()` 写回 `settings.json`。
- **数值约定**：32K（兼顾大角色卡体验与单次 token 成本；与内测决策一致）。
- **验证**：老用户 `openai_max_context` 从 4095 校正为 32768 后，同角色不再弹上下文超限警告。

---

## 5. 跨包修复：历史聊天切换 / 删除 / 重命名（冒烟 #4 历史项）

> 根因不在 vendor，但阻塞 MVP 验收；与 bridge 协议、backend、frontend 联动。此处记录完整链路便于维护。

- **现象**：侧边栏历史列表正常展示，但点击无法切换到该对话、删除/重命名无效；页面仍停留在当前对话。
- **根因（两处）**：
  1. **后端字段错配**：ST `/api/chats/recent` 经 `getChatInfo` 返回的角色头像是 **`avatar`** 字段；`backend/routes/chats.ts` 误读 **`character_avatar`**（不存在）→ 每条历史的 `characterAvatar` 为空 → 删除 API 缺 `avatar_url`、前端无法定位角色。
  2. **openChat/renameChat 未切角色**：历史列表为**跨角色聚合**（`/api/users/chats` 反代 ST recent），但 ST 的 `openCharacterChat` / `renameChat` 仅作用于 **`this_chid`（当前选中角色）**。不带 avatar 直接 open → 在当前角色下打开文件名，必然失败或行为异常。
- **修复**：
  - `backend/routes/chats.ts`：改读 `entry.avatar ?? entry.character_avatar`；顺带修正 `lastMessage`←`mes`、`messageCount`←`chat_items`。
  - `bridge-protocol`：`openChat` / `renameChat` payload 增加可选 **`avatar`**（目标角色 PNG 文件名）。
  - `st-extension/handlers/open-chat.ts`、`rename-chat.ts`：若 `payload.avatar` 与当前角色不同，先 `selectCharacterById` 再 open/rename。
  - `frontend/chat-sidebar.tsx`：点击/重命名/删除时传入 `item.characterAvatar`。
- **验证**：从贺商寒对话通过 bridge 打开「莫池来」历史 → 角色、ST 头部、chatId、消息内容均切到莫池来 ✓。

---

## 6. 跨包修复：模型档位切换「标准10 / 高级15」（冒烟 #5 切模型项）

> 切换逻辑在 st-extension + frontend；根因分两层。

- **现象**：工具栏「标准 10」「高级 15」加载后短暂 disabled；连上 bridge 后可点但高亮永停「标准」；切换后不确定是否生效。
- **根因 1 — changeModel 写错字段**：
  - 平台 ST 固定 `chat_completion_source = 'custom'`（LLM 走平台代理），模型存 **`oai_settings.custom_model`**，经 `#custom_model_id` input 写入。
  - 原 `handlers/change-model.ts` 按 frontend 传入的 `provider='openrouter'` 写 **`openrouter_model`** 并 trigger `#model_openrouter_select` → **对 custom 源完全不生效**。
  - **修复**：`source === 'custom'` 时写 `custom_model` + `$('#custom_model_id').val(model).trigger('input')`；并手动 `emit(CHATCOMPLETION_MODEL_CHANGED)`（custom 源 input 不自动广播该事件）。
- **根因 2 — 前端 mirror store 未接线**：
  - `ModelTierSwitcher` 用 `useSTMirror(s => s.currentModel)` 决定档位高亮；`bridgeStatus === 'ready'` 才启用按钮。
  - `useSTMirrorStore.updatePartial` **从未被调用** → `currentModel` 永为 `null` → 高亮永远落在默认「标准」；历史侧边栏 `currentChatId` 同理永不高亮。
  - **修复**：`bridge-client.ts` 在 handshake `ready` 后启动 **ping 轮询**（2.5s），st-extension 已有 `ping`→`pong`+`mirrorState`；`bridge-provider.tsx` 用 `onPong` 同步进 mirror store。
- **「按钮 disabled」**：全页加载后 bridge 未 `ready` 的短暂窗口（非持久 bug）；`ready` 后按钮可点。
- **验证**：点「高级」后 `custom_model` → `anthropic/claude-sonnet-4`，mirror 高亮跟随「高级」✓；代理扣费 premium=15 已在上一轮 llm-proxy 单测验证。

---

## 维护提示

- 改动 `st-extension` 后需 `pnpm --filter @miniapp/st-extension build`（产物自动拷贝进 `vendor/sillytavern/public/scripts/extensions/third-party/miniapp-bridge/`），浏览器**硬刷新**生效。
- 这些补丁都属于「嵌入形态下对 vendor 行为的最小侵入修正」。若未来改为**根路径**提供 ST（base 与 location 一致），补丁 2 可考虑下线；补丁 1/3/4 与部署路径无关，长期保留。
- **`openai_max_context` 双轨**：新用户看 `merger.ts`；老用户看补丁 4（`oai-settings-guard`）。两处数值须保持一致（当前 32768）。
