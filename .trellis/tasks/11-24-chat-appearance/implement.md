# 执行计划

## 1. 复用调研

| 检索过的                                                       | 结论                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `components/ui/sheet.tsx`（`overlayClassName`）                | 直接复用，界面设置标签下传透明遮罩                     |
| `use-pull-down-close.ts`、`useTelegramBackButton`              | 直接复用做收起                                         |
| `use-status-gestures.ts` 的 `readLocal/writeLocal`             | 复用本机存取的写法                                     |
| `chat-tools-panel.tsx`、`ToolsTabs`                            | 扩展 `TABS`，不新建抽屉                                |
| `character-editor-draft.ts` 的 IndexedDB 打开/升级写法         | 照抄结构，不抽公共库（只有两处使用，键和生命周期不同） |
| `profile-avatar-menu.tsx`、`character-editor-cover.tsx` 的选图 | 同样用 `<input type=file>`，Telegram 双端已在线上可用  |
| `lobbyImageUrl`                                                | 封面地址直接用                                         |
| `useStickToBottomResize`                                       | 贴底场景直接用，只补非贴底的锚点                       |
| 后端 `UserSettings` / `POST /api/users/avatar`                 | 不复用：见 design §1                                   |

## 2. 分两个 PR

1. **PR1 聊天背景（+字号）**：只动聊天页和工具箱，对没设过的人零影响。
2. **PR2 昼夜**：动 token 和约 378 处写死颜色。

PR1 先发；两者互不依赖，PR2 出问题可单独回滚。

## 3. 步骤

PR1

1. `lib/appearance/chat-background.ts`：数据形状、生效规则、遮罩/字底/自动采光纯函数；`image-store.ts`：导入、压缩、取样、存取。
2. `components/chat/chat-background.tsx` + `useChatBackground`；聊天根节点接入（顺手把 `page.tsx` 里会话抽屉与角色面板的挂载拆出去，不让超长文件继续变长）。
3. `chat-look-settings.tsx` 与第三个标签；拖动隐去、收起手势。
4. 字号切片。
5. ui-tests：新场景 `chat-look`，覆盖换图、范围、采光、重开仍在、存储不可用。

PR2

1. 先在现有夜间样式上跑全页截图作基线。
2. 加白天色板、`page/surface/veil` token、首帧脚本、store、图标（`ProfilePage` 超长，页头拆成 `profile-header.tsx`）。
3. 按文件替换写死颜色：充值 55 → 我的 29+21+14 → VIP 入口 → 底栏 12 → 角色卡 11 → 其余。每批后跑夜间截图比对，差异必须为 0。
4. 剧场、封面角标、VIP 卡、开屏包 `.dark`。
5. Telegram 配色。
6. ui-tests：`@theme` 分组，各主页面白天截图 + 首帧不闪断言。

## 4. 可靠性与最小充分

- 无外部调用、无重试、无事务。容量：图片 ≤12 张/人、单张压缩后一般 <400KB。
- 不引入主题库、不做多主题框架、不做服务端同步。
- 停止条件：夜间截图有差异即不合并；发布后聊天页 P95 劣化 >5% 或白天投诉看不清，隐藏图标并回滚 PR2。

## 5. 验证

- 自动：`pnpm -r typecheck`、`pnpm --filter @miniapp/frontend test`、`pnpm --filter @miniapp/reply-renderer test`（字号切片）、`pnpm lint:complexity`、`pnpm test:ui --grep "@chat|@profile|@roleplay|@theme"`、frontend build。
- 遮罩/字底/范围规则是纯函数且直接决定能否读清字，补一份小单测。
- 人工真机（Android、iOS 各一台，Telegram 内）：相册选图（HEIC、超大图、动图）、键盘弹起、生成中换图、重启后仍在、切昼夜看顶栏颜色、冷启动首帧、320px 宽。
- 模拟预览不能替代：系统相册、HEIC 解码、Telegram 顶栏颜色、键盘。

## 6. 建议纳入本地验收

新增 `chat-look`（背景/采光/范围/失败恢复）与 `@theme`（昼夜全页截图）两组，复用现有 fixture；未覆盖真实相册与 Telegram 配色。
