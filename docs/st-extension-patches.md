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

## 7. worldbook-autoimport（进入对话弹「是否导入角色内置世界书」确认框）

- **文件**：`src/patches/worldbook-autoimport.ts`
- **现象**：点角色卡进入对话时，先弹「This character has an embedded World/Lorebook. Would you like to import it now?」**阻塞式**确认框，需手动点「Yes」才进入发消息环节。用户不应感知此弹窗。
- **根因**：`script.js` 的 `getChatResult()` 内 `select_selected_character(chid)` → `world-info.js` 的 `checkEmbeddedWorld(chid)`：当角色含 `data.character_book`、`accountStorage` 无 `AlertWI_<avatar>` 标记、该书未链接（`extensions.world` 不在 `world_names`）、且 `power_user.world_import_dialog === true`（默认）时，`callGenericPopup(..., POPUP_TYPE.CONFIRM, { okButton: 'Yes' })` 弹阻塞框；点「Yes」→ `importEmbeddedWorldInfo(true)`（转换 + 落盘 + 链接）。
- **关键时机**：弹窗在 `getChatResult` 的 `select_selected_character`（早）触发，**早于** `eventSource.emit(CHAT_CHANGED)`（晚）。故无法照搬补丁 #3 的 `makeFirst(CHAT_CHANGED)` 拦截——会来得太晚。
- **修复（三道防线，等价于自动点「Yes」）**：
  1. **去阻塞**：`init` + `APP_READY` 置 `power_user.world_import_dialog = false`（经 `getContext().powerUserSettings`），把阻塞 CONFIRM 降级为非阻塞 toastr。因弹窗早于任何可监听事件，必须提前关开关保证绝不卡住用户；仅运行时内存覆写，不 `saveSettingsDebounced` 写回。
  2. **去 toastr**：`APP_READY` 为已加载且含 `character_book` 的角色预置 `accountStorage` 的 `AlertWI_<avatar>='true'`，使 `checkEmbeddedWorld` 连 info toastr 也不弹。
  3. **真导入**：`CHAT_CHANGED`（+ `init` 兜底一次）为当前角色静默导入——复刻 `importEmbeddedWorldInfo` 核心（`convertCharacterBook` + `saveWorldInfo(immediately)` + `updateWorldInfoList` + `writeExtensionField(chid,'world',bookName)`），但去掉其 UI 副作用（原函数 `trigger #WIDrawerIcon` 弹世界书面板 + success toastr）。用 `writeExtensionField` 直接写 `data.extensions.world`（内存 + json_data + 服务端 merge-attributes），不依赖角色编辑面板 DOM。
- **幂等与长期干净**：导入处先查 `getWorldInfoNames()`/`extensions.world`，已落盘且已链接则跳过；首次导入并链接后，后续进入因 `extensions.world` 已在 `world_names` 中，`checkEmbeddedWorld` 内层条件为 false → 天然不再弹窗/toastr。
- **为什么忠实于「Yes」而非仅消弹窗**：`getCharacterLore()` 生成时只读 `extensions.world` 与 `charLore`，**不**直接读未导入的 `character_book`；若仅消弹窗不导入，角色内置世界书对生成完全无效。故与补丁 #3「自动启用正则」一致，选择真导入以保留作者设定。
- **已知未覆盖 / 备选**：更彻底的根治是在 `sync-engine` provision（`merger.ts`）阶段就转换落盘 + 写 `extensions.world`，使 `world_names` 天然含它、弹窗根因消失（无需前端补丁，但需对存量用户重新 provision）。当前与现有补丁体系一致，先走 st-extension 侧。

---

## 8. tavern-helper-guard（第三方扩展「酒馆助手」TH-optimize 与平台冲突）

- **文件**：`src/patches/tavern-helper-guard.ts`

### 先厘清：酒馆助手是分功能、分开关的，别混为一谈

1. **前端渲染器 Renderer**（「启用渲染器」全局开关）：把消息里的 ` ```html ` 代码块渲染成富界面。是核心体验，**本身不调用大模型、不产生扣费**。它与「启用嵌入式脚本」确认框**无关**——不启用脚本，HTML 照样渲染。
2. **脚本库-角色脚本 Character Script**：随卡打包的 JS，注册进酒馆助手**常驻运行**。进卡弹的「角色卡 'xxx' 中包含酒馆助手可用的嵌入式脚本，是否现在就启用它们？」确认框，gate 的就是这个（`script.enabled.characters`，见 `src/panel/script/use_check_enablement_popup.ts`，其自有 Vue 弹窗、非 ST `callGenericPopup`）。
3. **渲染 iframe 内联脚本**：酒馆助手把 HTML 渲染进 iframe 时会注入完整 `TavernHelper`/`SillyTavern` API（`src/iframe/predefine.js`），所以渲染界面里自己的 `<script>` 也能调 `TavernHelper.generate()`。卡片的「动态交互」主要靠这个实现，**二次扣费也可能来自这里，不一定是脚本库**。

> 结论修正：**关脚本库不影响渲染**；二次扣费来源**不能**简单归到脚本库（撤销此前「不启用脚本=省成本默认」的错误倾向）。

### 本补丁处理的两项（决策 3a：扩展不得静默覆盖平台既定设置）

已核实 `src/type/settings.ts` 中 `optimize.*` 全部 `default(true)`。

1. **`maximize_preset_context_length`**（默认 true）：`src/panel/optimize/maximize_preset_context_length/index.ts` 把 `oai_settings.openai_max_context` 顶到 **2_000_000**、`max_context_unlocked=true`，并在 `SETTINGS_UPDATED` + `OAI_PRESET_CHANGED_AFTER`（切模型/切预设）反复重置。**与平台 `oai-settings-guard`(#4)/`merger.ts` 约定的 32768 直接冲突**，把单次上下文撑到 2M → token 成本暴涨。注意 `oai-settings-guard` 只「抬升」（`< 32768` 才改），**不会把 2M 降回来**。
2. **`force_recommended_worldbook_global_settings`**（默认 true）：`src/panel/optimize/force_recommended_worldbook_global_settings/index.ts` 经 `setLorebookSettings` 静默改写 ST **全局**世界书引擎设置（`context_percentage`=世界书可占 **100%** 上下文预算、`scan_depth=2`、`recursive=true`、`insertion_strategy=character_first` 等）。
   - **与 `worldbook-autoimport`(#7) 的冲突评估**：**无直接字段冲突**——#7 只写角色 `data.extensions.world`（决定「链接哪本书」），本项改「全局 WI 引擎怎么扫描/预算」，二者不写同一字段、不互相覆盖。且 `merger.ts` 未设任何 WI 全局项（只设 `openai_max_context=32768`）。
   - **但**它仍是「扩展静默覆盖平台未约定的全局行为」+ `context_percentage=100` 的成本风险（WI 可占满 32768 预算），按「不得静默覆盖」原则**一并关闭**。
   - **权衡**：关闭后全局 WI 回到 ST 默认；若某些卡的世界书激活依赖酒馆助手推荐值，行为可能变化。如负责人决定采用酒馆助手推荐 WI 设置，把本补丁源头关闭列表里这一行删掉即可（列为下方【待对齐项】）。

### 修复方式

1. **源头关闭**：尽早把 `extension_settings.tavern_helper.optimize.{maximize_preset_context_length, force_recommended_worldbook_global_settings} = false`。miniapp-bridge `loading_order=1` 早于酒馆助手 `loading_order=100` 的 pinia store 首次 `getSettings`（store 在 jQuery ready 内 `createApp().mount()` 时才读），故酒馆助手 zod 解析读到 false → 其 `watchImmediate(enabled=false)` 永不触发。
2. **兜底夹紧（仅 maximize）**：若时序竞态仍被顶到魔数 `2_000_000`，在 `APP_READY`/`OAI_PRESET_CHANGED_AFTER`/`CHATCOMPLETION_MODEL_CHANGED` 时夹回 32768（只针对恰为 2_000_000）。WI 全局设置无魔数/无逐轮重置，源头关闭即可。

- **数值约定**：32768，须与 `oai-settings-guard`、`merger.ts` 保持一致。

### 不处理 —— 【待产品 / 负责人对齐项】

- **渲染器 Renderer 保持常开**（核心体验，不扣费），不动。
- **是否自动启用角色脚本** + **是否承担「渲染 iframe 内联脚本 / 角色脚本」自发起生成的额外成本** → 待产品/负责人对齐。本轮**不实现** auto-confirm/auto-cancel 补丁；**保留原生确认弹窗（仅验证用，非最终方案）**。决策输入见下「单轮 2 次扣费归因」。
- **是否采用酒馆助手推荐的全局 WI 设置**（即是否恢复 `force_recommended_worldbook_global_settings`）→ 待对齐；当前按「不静默覆盖 + 控成本」关闭。
- **`better_character_update`**（默认开）：仅在 ST「更多…→替换/更新角色卡」时同步更新世界书，与 #7 不同入口、低频，正常用户流不并发，暂不处理。

---

## 9. 第三方扩展「酒馆助手」(JS-Slash-Runner) 的引入

> 这不是 vendor 补丁，而是**第三方 ST 扩展的可复现安装**。架构铁律不变：vendor 只读、third-party 是「产物/脚本安装」不入库（与 miniapp-bridge 同约定）。

- **是什么**：`N0VI028/JS-Slash-Runner`，前端 UI 扩展，让角色卡跑内嵌 JS/HTML、管变量、注入 UI、hook 大量 ST 事件。
- **pin 版本**：**v4.8.7**。
- **pin 快照（受 git 跟踪）**：`ops/st-extensions/JS-Slash-Runner/`，仅运行文件（~2.6MB）：
  `manifest.json`、`bundle/index.js`、`bundle/index.css`、`i18n/en.json`、`lib/jsoneditor.js`、`lib/tailwindcss.min.js`。详见该目录 `README.md`。
- **`lib/` 是硬依赖**：
  - `dist/index.js` 静态 `import '../lib/jsoneditor.js'` —— 缺失则整个扩展加载失败。
  - render 把 `lib/tailwindcss.min.js` 按**绝对路径**（`.../third-party/JS-Slash-Runner/lib/tailwindcss.min.js`）注入消息渲染 iframe。
  - 其它依赖（如 `speakingurl`）已**内联**进 `bundle/index.js`，无需单独文件。
- **为什么快照用 `bundle/` 而非 `dist/`**：仓库根 `.dockerignore` 含 `**/dist`、`**/node_modules`；快照里若直接放 `dist/` 会被 Docker 构建上下文剔除。故快照存 `bundle/`，安装脚本落地时映射到 vendor 的 `dist/`（manifest 仍引用 `dist/`，无需改）。
- **安装脚本（幂等，本地 + Docker 共用）**：`scripts/install-st-extension.mjs`（纯 `node:fs`，免 tsx）。每次先清空目标目录再拷贝，并断言关键文件存在；`vendor/sillytavern` 不存在时跳过。
- **pnpm 入口**：`pnpm st-ext:install`；`predev:st` 钩子让 `pnpm dev:all`/`dev:st` 自动安装。
- **快照 vs 构建期从源码出 dist 的取舍**：源码出 dist 需 `vite + tailwind + pnpm`（较重、需联网、复现性依赖上游与工具链）；快照方案**离线可复现**、CI/Docker 稳定，代价是 ~2.6MB 运行文件入库。本平台选**快照**。
- **Docker 接线**：`ops/docker/Dockerfile.st-bundle` 的 `builder-ext` 阶段 `COPY scripts/install-st-extension.mjs` + `COPY ops/st-extensions` → `RUN node scripts/install-st-extension.mjs` → 构建期断言 `manifest.json + dist/index.js + dist/index.css + lib/jsoneditor.js + lib/tailwindcss.min.js` 存在（仿 miniapp-bridge）。runtime 阶段 `COPY --from=builder-ext .../vendor/sillytavern` 把它烤进镜像。`ops/sillytavern/config.production.yaml` 的 `extensions.enabled: true` 已满足（客户端默认启用，除非用户 `disabledExtensions` 含它）。
- **已发现的交叉与处理**：见上文补丁 8（`tavern-helper-guard`：关闭 `maximize_preset_context_length` 保 32768、关闭 `force_recommended_worldbook_global_settings`；渲染器/角色脚本/二次扣费归因列为待产品对齐项）。

### 单轮 2 次 `chat/completions` + 扣费 —— 归因（决策 3b：用日志/控制台坐实，不靠猜）

- **代码级机制（已核实）**：酒馆助手向卡内 HTML/JS 暴露 `TavernHelper.generate()/generateRaw()`（`src/function/generate/index.ts`）。其 `generateResponse`（`src/function/generate/responseGenerator.ts:537/562`）最终调用 ST 的 `sendOpenAIRequest('normal', …)`，或直接 `fetch('/api/backends/chat-completions/generate')`（行 297/382）—— 与用户正常发消息**走同一端点**，经平台 `llm-proxy` → 正常计费。后端按路径**无法区分**两次请求。
- **可能来源有三类，必须逐一排除**（不能简单归到脚本库）：
  1. **渲染 iframe 内联脚本**：渲染界面里的 `<script>` 调 `TavernHelper.generate()`（靠 `src/iframe/predefine.js` 注入的 API）。**即使角色脚本未启用，只要渲染器开 + 卡片 HTML 自带生成调用，就会发生**。
  2. **脚本库-角色脚本**：仅在弹窗点「确认」启用（`script.enabled.characters` 含该卡）后才常驻运行并可能自发起生成。
  3. **swipe / 重发**：ST 原生 `GENERATION_STARTED`（type `swipe`/`regenerate`），用户操作触发，非「单轮自动第 2 次」。
- **关联探针（前端：ST iframe = `/tavern` frame 的控制台）**：发消息前粘贴。它给出**类别**与**单次 token 量级**，配合后端 `deduction success` 计数即可坐实。

```js
(() => {
  const { eventSource, eventTypes } = SillyTavern.getContext();
  const approxTokens = (data) => {
    try {
      const msgs = data?.messages ?? data?.prompt ?? [];
      const chars = (Array.isArray(msgs) ? msgs : []).reduce(
        (n, m) =>
          n +
          (typeof m?.content === 'string'
            ? m.content.length
            : JSON.stringify(m?.content ?? '').length),
        0
      );
      return Math.round(chars / 4); // 粗估 ~4 chars/token
    } catch {
      return '?';
    }
  };
  const tag =
    (t, c) =>
    (...a) =>
      console.log(`%c[GEN-DIAG] ${t}`, `color:${c}`, ...a);
  // ST 原生：用户发送 / swipe / 重发（第一个参数是 type）
  eventSource.on(eventTypes.GENERATION_STARTED, (type, ...a) =>
    console.log('%c[GEN-DIAG] ST GENERATION_STARTED', 'color:#06c', 'type=', type, ...a)
  );
  // 酒馆助手 API 发起（iframe 内联脚本 或 角色脚本，二者都走这里）
  eventSource.on(
    'js_generation_started',
    tag('TH js_generation_started (iframe内联/角色脚本)', '#c60')
  );
  eventSource.on('js_generation_ended', tag('TH js_generation_ended', '#c60'));
  // 抓单次 token 量级（ST 与 TH 发请求前都会 emit 这个事件）
  eventSource.on(
    eventTypes.CHAT_COMPLETION_SETTINGS_READY ?? 'CHAT_COMPLETION_SETTINGS_READY',
    (data) => console.log('%c[GEN-DIAG] settings_ready ~tokens=', 'color:#093', approxTokens(data))
  );
  console.log('[GEN-DIAG] 已安装：现在发 1 条消息，数 tag、记 ~tokens');
})();
```

- **后端**：同一发送窗口内 `grep '\[llm-proxy\] deduction success'`，每次计费一行（含 `model`、`amount`）；行数 = 该轮实际计费次数。
- **A/B 归因协议（确定性，无需改代码）**：
  - **A（渲染器开 + 角色脚本不启用）**：进卡时弹窗点「取消」→ 发 1 条消息。若仍 `2× deduction` 且控制台见 `js_generation_started` → **来源 = 渲染 iframe 内联脚本**（因角色脚本未启用）。
  - **B（渲染器开 + 角色脚本启用）**：进卡时弹窗点「确认」→ 发 1 条消息。若相对 A **多出** `js_generation_started`/`deduction` → 多出的部分 = **角色脚本**贡献。
  - **swipe**：点 swipe 箭头 → 见 `GENERATION_STARTED type=swipe`（用户主动，归第 3 类）。
- **要交付的归因数据**（产品/负责人决策输入，需在本地 5 进程环境实跑后填表，本步不臆测、不预先节流）：

| 场景            | deduction 次数/轮 | 类别（iframe内联/角色脚本/swipe） | 单次 ~tokens | 备注/复现率 |
| --------------- | ----------------- | --------------------------------- | ------------ | ----------- |
| A 渲染开·脚本关 | _待填_            | _待填_                            | _待填_       | _待填_      |
| B 渲染开·脚本开 | _待填_            | _待填_                            | _待填_       | _待填_      |

> 本环境无法跑真实计费生成（需 Supabase + 真扣费 + 运行中 5 进程），故上表留空、由本地实跑填入；判读规则与协议如上，结论不靠猜。

---

## 维护提示

- 改动 `st-extension` 后需 `pnpm --filter @miniapp/st-extension build`（产物自动拷贝进 `vendor/sillytavern/public/scripts/extensions/third-party/miniapp-bridge/`），浏览器**硬刷新**生效。
- 这些补丁都属于「嵌入形态下对 vendor 行为的最小侵入修正」。若未来改为**根路径**提供 ST（base 与 location 一致），补丁 2 可考虑下线；补丁 1/3/4 与部署路径无关，长期保留。
- **`openai_max_context` 三处一致**：新用户看 `merger.ts`；老用户看补丁 4（`oai-settings-guard`）；第三方扩载酒馆助手会顶到 2M，由补丁 8（`tavern-helper-guard`）关闭其 `maximize_preset_context_length` 并夹回。三处数值须保持一致（当前 32768）。
- **第三方扩展（酒馆助手）安装**：见第 9 节；改快照/重装后跑 `pnpm st-ext:install` 并重启 ST + 浏览器硬刷新。
