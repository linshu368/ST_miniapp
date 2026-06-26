# MVP 收尾行动路径

> 目标：**先跑出一版可内测的产品，能正常体验 MVP 功能**。
> 本文基于 2026-06-26 对主干代码的实测扫描 + 5 项方向性确认重排。
> 状态约定：✅ 已具备 ｜ 🔴 P0（阻塞可体验）｜ 🟡 P1（内测分发/上线）｜ ⚪ 技术债（上线后迭代）

---

## 0. 关键判断（决定优先级）

1. **核心闭环本地已跑通**：LLM 计费链已在本地端到端验证（后端日志 `deduction success, amount=10, model=google/gemini-2.5-flash`）。这意味着 provision、ST 多用户、切角色、发消息、代理转发、按 tier 扣费（standard=10 / premium=15）这条主链路本地可用，**不是从零开发**。
2. **本地联调是最快路径**：Next rewrite 已实现 `/tavern/*` 同源、mock TG 身份（`NEXT_PUBLIC_USE_MOCK_INIT_DATA=1` + 后端 `MOCK_AUTH=1`）已配、改一行即时生效、无部署周期。
3. **因此：云部署（Vercel + Railway）降为 P1**，待本地完整调通后再做，用于真实内测分发。P0 聚焦"本地一键拉起 + 完整冒烟 + 补齐缺口 + 清架构红线"。

---

## 1. 已具备（无需重做）

| MVP 功能                                     | 证据                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 点角色卡进对话页                             | `character-gallery.tsx` → `app/tavern/[characterId]/page.tsx` → `selectCharacter`                                  |
| 常驻 iframe + 可见性切换                     | `providers.tsx` / `components/bridge/{bridge-provider,st-iframe}.tsx`                                              |
| 桥接协议（7 actions / 13 events / 两段握手） | `bridge-protocol` + `st-extension/{handlers,forwarders,handshake}`                                                 |
| 历史聊天（列表/切换/重命名/删除）            | `chat-sidebar.tsx` + backend `routes/chats.ts`（反代 ST `/api/chats/recent`）                                      |
| 切换模型 + 改扣费额                          | `model-tier-switcher.tsx` + `change-model.ts` + `platform/model-tiers.ts`                                          |
| LLM 代理 + per-user 计费                     | `routes/llm-proxy.ts`（JWT 验签 + 402 预检 + SSE 扣费）+ provisioner `writer.ts`（per-user JWT 写入 secrets.json） |
| 新用户首登三阶段 provision                   | `routes/bridge.ts` st-session                                                                                      |

---

## 2. P0 — 本地内测调通（阻塞"可体验"）

> 进度（2026-06-26 复核）：P0-1 / P0-3 / P0-4 已完成并经代码核验，**当前唯一未完成 P0 = P0-2 端到端冒烟验收**。

### P0-1 ✅ 本地一键编排 + quickstart（已完成）

- 已具备：根 `pnpm dev:all`（concurrently 并发 5 进程：st / prov / watch / be / fe，前缀着色）+ `docs/QUICKSTART.md`（env 前置 / 端口 / 启动顺序 / 冒烟清单 / FAQ）。`config.yaml` 已设 `enableUserAccounts: true`。
- 残留（不阻塞）：`pnpm dev`（非 `:all`）仍仅并发 frontend + backend，作为轻量调试入口保留。

### P0-2 🔴 完整端到端冒烟 + 逐项验收（当前任务）

跑通一次完整链路并验收 6 个 MVP 功能：

1. 登录（mock TG）→ 大厅角色卡渲染
2. 点角色卡 → 进对话页 → **自动收到角色背景/首句（走 ST 原生）** ← 重点验证 `selectCharacterById` 是否触发原生首句
3. 正常对话（经 backend LLM 代理 + 扣费）
4. 历史聊天：列表 / 点击切换继续聊 / 重命名 / 删除
5. 切换模型 → 下次生成用新模型 + 扣费额变化（10↔15）
6. 重登后：模型等级、历史聊天保持上次状态

**冒烟已暴露并修复的缺口（详见 `docs/st-extension-patches.md`）**：

- ✅ 对话页 ST 整体不渲染 / 发送按钮消失 / 消息发不出：`tabs-base-guard`（§2）
- ✅ 进入对话弹「是否启用角色内置正则」：`regex-autoconfirm`（§3）
- ✅ 「提示词超过上下文大小」：`merger.ts` 新用户 + `oai-settings-guard` 老用户登录校正（§4）
- ✅ 历史聊天点击不切换 / 删除重命名无效：跨包修复 avatar 字段 + openChat 先切角色（§5）；UI 实测 切换/新建/删除/高亮均通过
- ✅ 模型档位切换不生效 / 高亮不对：changeModel 写 custom_model + mirror ping 接线（§6）
- ⏳ 仍待 UI 复验（3 件）：①历史**重命名**点一次 ✏️；②#5 切高级后发消息看 be 日志 `amount=15`；③#6 刷新/重登后模型档 + 历史状态保持

### P0-2 逐项验收状态（2026-06-26 UI 冒烟更新）

| #   | 功能                                     | 状态 | 说明                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | mock 登录 → 大厅角色卡                   | ✅   | 角色列表正常渲染                                                                                                                                                                                                                                                             |
| 2   | 点卡进对话 → 自动首句                    | ✅   | 用户确认 + 实测 selectCharacter 触发 ST 原生首句                                                                                                                                                                                                                             |
| 3   | 发消息 → 代理 + 扣费                     | ✅   | 发送/回复/扣费（10/15/402）均已验证                                                                                                                                                                                                                                          |
| 4   | 历史：列表 / 切换 / 新建 / 删除 / 重命名 | 🟡   | **UI 实测**：列表 ✅ / 切换（贺商寒→莫池来 ST 头部+内容切换）✅ / 新建（+ 后列表 7→8 且新对话置顶高亮）✅ / 删除（删高亮新对话后从列表消失、active 转移）✅；**重命名 ⏳ 未完成**（依赖 `window.prompt`，浏览器自动化注入被 Auto-review 拦截，需人工点一次 ✏️ 输入新名验证） |
| 4.1 | mirror 高亮（currentChatId）             | ✅   | **本次确认接线生效**：当前对话在侧边栏粉色高亮，切换/新建后高亮正确跟随转移（修复 mirror ping 接线的直接证据）                                                                                                                                                               |
| 5   | 切模型 + 扣费额变化                      | 🟡   | 切换 + 高亮已通（前序）；**待发消息后确认后端 deduction amount 随 tier 变（标准10↔高级15）**                                                                                                                                                                                 |
| 6   | 重登后状态保持                           | ⏳   | 未测：刷新/重登后模型档位 + 历史聊天是否保持                                                                                                                                                                                                                                 |

> 进度小结：6 项中 1/2/3 完整通过；4 大头（列表/切换/新建/删除/高亮）UI 实测通过，仅「重命名」UI 复点未做；5、6 待验。**剩余三件事**：①重命名点一次 ✏️ ②切高级发消息看 be 日志 `amount=15` ③刷新重登看状态保持。

### P0-3 ✅ LLM endpoint 指向代理已固化进 provision（已完成）

- 已具备：`provisioner/merger.ts:95` 合并 settings 时写入 `oai_settings.custom_url = config.LLM_PROXY_URL`（默认 `http://localhost:3001/api/platform/llm-proxy/v1`，见 `lib/config.ts`、`fetcher.ts` 回退默认）。换环境只需改 `LLM_PROXY_URL` 一个变量。
- 已清理：游离脚本 `packages/sync-engine/update_proxy.ts` 已删除。

### P0-4 ✅ 架构红线已修复：power-user.js 改动迁出 vendor（已完成）

- 已修复：`vendor/sillytavern/public/scripts/power-user.js` 已回退为原始（git 工作区干净，3457 行恢复为未包裹的原始代码）。
- 迁移方案：防御修复改到 `st-extension/src/patches/autocomplete-guard.ts`——包装 `$.fn.autocomplete`，元素未初始化时 `widget` 调用返回一个 `display:none` 的游离元素，使 `power-user.js` 的 `.autocomplete('widget')[0].style.display !== 'none'` 安全求值；`entry.ts` 启动时 `installAutocompleteGuard()`（带重试以赶在首次 resize 前就位）。vendor 保持零改。

---

## 3. P1 — 内测分发 / 上线

### P1-1 🟡 Supabase Storage 角色卡集成

- 资产来源（已确认）：酒馆生态角色卡 PNG（自带角色数据），由运营上传到 Supabase Storage。
- 现状：provisioner `writeCharacters` 从本地 `ST_PLATFORM_ASSETS_PATH` 复制 PNG；仓库无 `platform-assets/`，Storage 未接。
- 必做：provisioner 从 Supabase Storage 拉取 `platform_<uuid>.png` 下发到 ST 文件系统（对应阶段 5 Storage 迁移的最小子集）。本地调通阶段可暂用本地 PNG 占位。

### P1-2 🟡 云部署（5 单元 + 单域名 nginx）

- 平台（已确认）：frontend → Vercel；backend / ST 原生 / sync-engine（provision-api + watcher）/ nginx → Railway。
- 必做：`ops/nginx`（生产单域名分发 `/`→Vercel、`/tavern/*`+ST `/api/*`→ST、`/api/platform/*`→backend）、`ops/docker`（ST Dockerfile 含 st-extension 产物拷贝）、生产 env、目标 Supabase 应用 001–020 迁移 + seed、真实 TG WebView 入口联调。

---

## 4. ⚪ 技术债（不阻塞 MVP，上线后迭代）

- 聊天记录回流 `st_users.user_st_chats`（MVP 历史列表走反代 ST 已够用）
- `db-types` 实际接线 / `api-contract` 独立拆包 / `backend/config.ts` 收敛为 zod 校验
- provision 增量 / 状态查询 / flush、Realtime、settings 分段精细化
- `characters` 表 `enabled` 与 `is_published`/`is_active` 字段语义统一
- backend 与 sync-engine 重复的 JWT 签发 / ST 登录逻辑去重
- `model-tiers` 硬编码迁入 `miniapp.runtime_config` 热更
- `handshake.ts` 中 `#api_button_openai` 自动点击的脆弱 hack

---

## 5. 执行顺序

```
P0-1 一键编排 ✅ ─┐
P0-3 provision 固化 ✅ ─┼─► P0-2 冒烟验收（当前）──► （冒烟暴露的缺口逐个补）
P0-4 红线修复 ✅ ─┘                │
                                   ▼
              P1-1 Storage 集成 ──► P1-2 云部署 ──► 真实内测
```

> 当前进度：P0 仅剩 P0-2（端到端冒烟验收）。验收清单见 `docs/QUICKSTART.md` §4。
