# ST 冷启动 firstLoadInit 串行调用并行化 —— 交接方案（①+②）

> 面向：接手实现「①并行化 firstLoadInit 串行网络调用 + ②跳过 boot 期无用网络调用」的窗口。
> 本文给出背景、思路、**逐行最小 diff 方案、依赖关系、`[miniapp-patch]` 标注规范、回滚方案、验证口径**。
> 上下文：`iframe-cold-boot-progress.md`（基线/已落地优化）、`iframe-cold-boot-optimization.md`（架构与排查法）、`ARCHITECTURE.md`（铁律）。
>
> ⚠️ **这是本项目第一次修改 vendor**。`vendor/sillytavern/` 原为只读锁定（见 `NOTICE.md`）。
> 动手前务必逐条走完本文「依赖核验」与「硬约束」。

---

## 〇、进展状态（2026-07-13 更新）

- ✅ **Tier-1 已落地**：commit `42196e8`（分支 `dev_iframe-boot-stall-fix`，PR #111，2026-07-10 合入 `dev`，已进 `main`）。
  改动点 A/B 均按本文 §三 实施，`[miniapp-patch]` 注释与 `NOTICE.md` 登记已完成。
  注：pre-commit prettier 把 `Promise.all([...])` 折叠为单行，与本文示例的多行写法等价。
- ✅ **Tier-2 专项核验已完成（2026-07-13，结论：安全，可实施）**，详见 §四.4 的核验结果。
- ✅ **Tier-2 已实施（2026-07-13）**：改动点 B 去掉 `getBackgrounds()`，单独 commit，NOTICE.md 已更新。
- 📊 **pro 实测数据修正预期（2026-07-13，Tier-1 后 528 个干净冷启动 + 233 个瀑布样本）**：
  - Tier-1 并行已验证生效（92% 瀑布样本三请求起点重叠 <500ms）。
  - 真实用户基线比开发机重：全长 P50 15.9s / P75 23.5s / P80 26.9s（Android 占 84%，重尾）。
  - Tier-2 收益是**尾部收益**：backgrounds 耗时 P50 0.6s 但 P75 2.0s / P90 2.7s，为并行组尾巴的样本占 36%；
    预估节省 P50≈0 / P75 0.7s / P80 1.1s / P90 1.6s。§七 复测口径应看 P75/P80 而非中位数。
- ⏭️ **下一步**：部署后按 §七 复测（重点：nginx boot 段无 `/api/backgrounds/all`、P75/P80 下降、功能回归）。

---

## 一、背景：为什么做这个

欢迎屏抑制落地后，干净冷启动 ~13s 的分段基线：

| 段                           | 耗时      | 构成                                                                             |
| ---------------------------- | --------- | -------------------------------------------------------------------------------- |
| 网络(bridge_start→onload)    | ~3.9s     | /tavern 文档 + 同步资源(已缓存) + 跨洲首连                                       |
| script+ext_init(onload→握手) | ~3.4s     | 手机解析 lib.js+~200 模块(CPU) + **firstLoadInit 前段串行网络调用**              |
| boot 后段(握手→APP_READY)    | ~5.4-6.6s | 扩展窗口~2s + 角色列表~0.7s + **尾段~2.7s（含 firstLoadInit 后段串行网络调用）** |

**诊断：boot 是「串行 RTT 碎片囤积」，无单点大石头。** `firstLoadInit`（vendor
`public/script.js:813-914`）是一条几十个 `await` 的长链，其中若干是**彼此无依赖的跨洲
fetch**，每个 ~100-300ms RTT，串起来成秒级。攻击点就是把这些无依赖 fetch 从 N×RTT 压到 1×RTT。

- **①** 把无依赖的网络调用 `Promise.all` 并行化。
- **②** 跳过平台根本用不到、却仍在 boot 关键路径上 `await` 的网络调用。

预估合计省 **1.5~3s**，把干净冷启动从 ~13s 压向 ~10~11s。不动部署架构、收益最确定。

---

## 二、firstLoadInit 解剖（vendor `public/script.js:813-914`）

只列**带网络/在关键路径**的调用（其余 `initXxx()` 多为同步绑定，不动）：

### 前段（getSettings 之前，行 858-861）

| 行  | 调用                       | 网络                          | 依赖                                               | 可并行                     |
| --- | -------------------------- | ----------------------------- | -------------------------------------------------- | -------------------------- |
| 858 | `await getClientVersion()` | `GET /version`                | 无（设 CLIENT_VERSION/currentVersion 全局）        | ✅                         |
| 859 | `await initSecrets()`      | **无**（仅绑 DOM 事件处理器） | 无                                                 | ✅（含入无害，省不了 RTT） |
| 860 | `await readSecretState()`  | `POST /api/secrets/read`      | 不依赖 initSecrets（各自写 `secret_state`/绑事件） | ✅                         |
| 861 | `await initLocales()`      | 取 locale json + 应用 i18n    | 无                                                 | ✅                         |

> 已核验：`initSecrets()`（secrets.js:1231）纯绑 `$(...).on(...)` 处理器，无 fetch；
> `readSecretState()`（secrets.js:428）才是 `/api/secrets/read`，两者无先后依赖。
> 三个真网络调用（858/860/861）互相独立。

### 后段（getSettings 之后，行 876-909）

| 行  | 调用                                      | 网络                                                                  | 依赖                                                         | 处置                            |
| --- | ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------- |
| 876 | `await checkOpenRouterAuth()`             | 仅当 URL `?source=openrouter`（平台无此参数）→ **早返回，近乎零成本** | —                                                            | 不动                            |
| 881 | `await getUserAvatars(true, user_avatar)` | `POST /api/avatars/get` + 渲染 persona                                | 无（读 power_user，getSettings 已完成）                      | ✅ 可并行                       |
| 882 | `await getCharacters()`                   | 浅层角色列表（lazyLoad 已开）                                         | 无                                                           | ✅ 可并行                       |
| 883 | `await getBackgrounds()`                  | `POST /api/backgrounds/all`                                           | **平台不展示 ST 背景（用 `__transparent.png`）→ 结果未使用** | ②跳过候选（⚠️ 见下）            |
| 884 | `await initTokenizers()`                  | `loadTokenCache()`（**本地缓存**，非网络）                            | —                                                            | 不动（非网络，省不了 RTT）      |
| 887 | `await initPersonas()`                    | 绑事件 + `migrateNonPersonaUser()`                                    | **可能软依赖 getUserAvatars 已渲染 persona UI**              | ⚠️ 保持在并行组之后，勿并入     |
| 902 | `await initScrapers()`                    | **无**（本地注册 6 个 scraper 对象）                                  | —                                                            | 不动（非网络）                  |
| 909 | `doDailyExtensionUpdatesCheck()`          | 扩展更新检查（**未 await → 不在 APP_READY 关键路径**）                | —                                                            | 可选跳过（对 APP_READY 耗时≈0） |

> 关键修正：`initScrapers`/`initTokenizers` 经核验是**本地操作非网络**，不是②的目标；
> ②真正在关键路径上的网络浪费只有 `getBackgrounds`（883）。`doDailyExtensionUpdatesCheck`
> 未被 await，跳过它对 APP_READY 墙钟≈0（只减后台负载），列为可选。

---

## 三、最小 diff 方案（分两档，按风险递增；建议先只做 Tier-1）

### Tier-1（低风险，只并行、不跳过任何调用）—— 先做这个

**改动点 A：前段 858-861 → 一个 Promise.all**

原（行 858-861）：

```js
await getClientVersion();
await initSecrets();
await readSecretState();
await initLocales();
```

改为：

```js
// [miniapp-patch] 冷启动并行化：这 4 个调用互不依赖（initSecrets 仅绑事件无网络，
// getClientVersion/readSecretState/initLocales 为独立 fetch）。串行 4×RTT → 1×RTT。
// 全部在此 await 完成，行 862+ 的消费者时序不变。见 docs/iframe-boot-firstloadinit-parallelization.md
await Promise.all([getClientVersion(), initSecrets(), readSecretState(), initLocales()]);
```

**改动点 B：后段 881-883 → getUserAvatars/getCharacters/getBackgrounds 并行**

原（行 881-883）：

```js
await getUserAvatars(true, user_avatar);
await getCharacters();
await getBackgrounds();
```

改为：

```js
// [miniapp-patch] 冷启动并行化：三个独立 fetch（avatars/characters/backgrounds），
// 均在此 await 完成，后续 initBackgrounds(885)/initPersonas(887) 时序不变。
await Promise.all([getUserAvatars(true, user_avatar), getCharacters(), getBackgrounds()]);
```

> Tier-1 只重排执行方式、**不删任何调用**，行为等价、风险最低。`initPersonas`(887) 仍在其后串行，
> 软依赖不受影响。预估省 ~1~2s（取决于实测各 RTT）。

### Tier-2（核验已通过，可实施）—— 跳过 getBackgrounds

> ✅ 2026-07-13 核验通过（见 §四.4），前置条件满足。

若 Tier-1 复测稳定、还想再抠 getBackgrounds 那次 RTT：

改动点 B 去掉 `getBackgrounds()`：

```js
// [miniapp-patch] 平台不展示 ST 背景（settings 固定 __transparent.png），跳过 /api/backgrounds/all。
await Promise.all([getUserAvatars(true, user_avatar), getCharacters()]);
```

⚠️ **必须先核验**：`initBackgrounds()`(885) 在 `getBackgrounds()` 未拉数据时不抛错、不卡 boot
（它读的背景列表会是空/旧值）。若 `initBackgrounds` 强依赖 `getBackgrounds` 写入的全局，则**不做 Tier-2**，
保留 883 在并行组内即可。**可选**：`doDailyExtensionUpdatesCheck()`(909) 因扩展锁版本可一并注释跳过，
但它未被 await，对 APP_READY 墙钟无收益，非必要不动。

---

## 四、依赖核验清单（实现窗口动手前逐条确认）

1. **前段组**：行 862-874（initTextGenModels/initOpenAI/initExtensions/getSettings 等）是否读取
   `secret_state` / locale / `CLIENT_VERSION`？→ 只要它们在 Promise.all **之后**执行即安全（本方案保证）。
   确认无「859 之前就要用到 860 结果」的逆序依赖（已核验：无）。
2. **后段组**：`initBackgrounds`(885)、`initPersonas`(887)、`initTokenizers`(884) 是否依赖
   avatars/characters/backgrounds 的**返回值**而非全局副作用？→ 三者都靠全局副作用（渲染 DOM/填全局），
   Promise.all 完成后再执行，时序保持。确认 `initPersonas` 不需要与 `getUserAvatars` **交错**执行。
3. **错误语义**：原串行下前者抛错则后者不执行；Promise.all 改为「任一 reject 即整体 reject」。
   已核验这些函数内部各有 try/catch 或 `response.ok` 守卫，正常不抛。仍建议保留其内部容错，不额外包裹。
4. **Tier-2 专项**：`grep initBackgrounds` 读其实现，确认空背景列表不抛。
   ✅ **已核验（2026-07-13），结论：跳过 `getBackgrounds()` 安全**：
   - `cachedSystemBackgrounds` 初值 `[]`（backgrounds.js:131）、`THUMBNAIL_CONFIG` 有默认值（:75）、
     `folderList` 为空；所有读取方（`findIndex`/`map`/`filter`/`find`）对空数组安全，不抛错。
   - `initBackgrounds()`（:1782）boot 时只绑事件 + 调 `updateGroupFolderControlsVisibility()`/
     `syncGroupSelectionUi()`，仅读空 Set 与空 jQuery 选择器，不依赖 `getBackgrounds` 写入的数据。
   - 进卡 `CHAT_CHANGED` → `onChatChanged()`（:288）只用 `background_settings.url`（来自 settings）
     和 `chat_metadata`，与系统背景列表无关。
   - 兜底：`getBackgrounds()` 另有 3 个用户操作触发的调用点（重命名 :558 / 上传 :1651 /
     缩略图动画开关 :1951），用户若在背景面板操作会重新拉取。唯一行为差异：直接打开
     Backgrounds 抽屉时系统背景列表为空——平台不展示该抽屉（settings 固定 `__transparent.png`），无影响。

---

## 五、`[miniapp-patch]` 标注规范 + NOTICE.md 登记

1. **每处改动**加行内注释，前缀 `[miniapp-patch]`，一句话写清「为什么改 + 等价性保证」，
   便于日后 `rg "\[miniapp-patch\]" vendor/` 一键审计全部 vendor 改动。
2. **更新 `vendor/sillytavern/NOTICE.md`**：现有内容声明「Do NOT modify」。新增一节「Local patches」登记：

   ```markdown
   ## Local patches (miniapp)

   本 vendored 副本含以下**受控**本地改动（例外于只读约束，经 ARCHITECTURE 铁律放开，仅限冷启动优化）。
   审计：`rg "\[miniapp-patch\]" vendor/sillytavern/`。

   | 文件             | 位置               | 改动                                                 | 原因            | 回滚                                                    |
   | ---------------- | ------------------ | ---------------------------------------------------- | --------------- | ------------------------------------------------------- |
   | public/script.js | firstLoadInit 前段 | 858-861 串行→Promise.all                             | 冷启动并行化①   | 见 docs/iframe-boot-firstloadinit-parallelization.md §6 |
   | public/script.js | firstLoadInit 后段 | 881-883 串行→Promise.all（Tier-2 去 getBackgrounds） | 冷启动并行化①/② | 同上                                                    |
   ```

3. commit message 讲清是 vendor 改动、通道 B、附本文件路径。PR 描述提示 reviewer 重点看 vendor diff。

---

## 六、回滚方案

- **粒度**：改动 A、B 相互独立，可分两个 commit，便于单独回滚。
- **回滚动作**：把对应 `await Promise.all([...])` 还原为原来的顺序 `await xxx();` 逐行，删除 `[miniapp-patch]`
  注释，并回退 NOTICE.md 对应行。因是纯执行顺序变更、无签名/接口变动，`git revert <commit>` 即可干净回退。
- **线上应急**：若部署后出现 boot 异常（白屏/卡在 splash/persona 或背景报错），立即 `git revert` 该 vendor
  commit 重新部署；因改动不涉及数据写入，回滚无数据副作用。
- **保留验证埋点**：回滚优化本身不影响 `[iframe-timing]` 埋点（它们独立），复测口径不变。

---

## 七、验证口径（部署后）

1. 采 ≥5 个**干净冷启动**样本（非停摆），看主 beacon：
   - `[冷]st_script+ext_init`（含前段并行收益）应下降；
   - `[冷]st_app_boot(→APP_READY)`（含后段并行收益）应下降；
   - `点卡→呈现` 干净冷启动中位数目标从 ~13s → ~10~11s。
2. 瀑布行 `[iframe-timing-wf]`：前段 `/version`+`/api/secrets/read`+locale、后段 `/api/avatars/get`+
   `/api/characters/*`+`/api/backgrounds/all` 的 `start@+dur` 应从**依次错开**变为**起点几乎重叠**（并行的直接证据）。
3. nginx（`railway logs -s nginx-pro`）：Tier-2 后 boot 段应**不再出现** `/api/backgrounds/all`。
4. 功能回归：进卡正常、persona 名字/头像正确、角色列表正常、无 splash 卡死。

---

## 八、硬约束（务必遵守）

- 铁律仅对 **firstLoadInit 这段冷启动优化** 放开 vendor 修改；**不得**借机改动 script.js 其他区域或其他 vendor 文件。
- 最小 diff：只改执行顺序/删无用调用，**不重写、不重排无关行、不改函数签名**。
- 上游 merge 保护：vendor 锁 commit `51ad27fb...` 不变；本改动是本地 patch，不是升级。
- 先 Tier-1、复测稳定再评估 Tier-2；两档分 commit。
- 与「停摆修复」窗口的改动互不重叠（那边动 frontend bridge-client / st-iframe；这边只动 vendor script.js + NOTICE.md），合并时注意不要互相回退。
