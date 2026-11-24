# 技术设计

全部在 `packages/frontend`，无接口、无数据库、无新依赖。

## 1. 状态与存储

| 内容     | 存哪                                             | 说明                                                                                                                                                            |
| -------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 昼夜     | localStorage `st_miniapp_theme`（`night`/`day`） | 设备级，不带用户：首帧脚本运行时还拿不到 Telegram 身份                                                                                                          |
| 字号档   | localStorage `st_miniapp_reply_size`（0–4）      | 设备级                                                                                                                                                          |
| 背景选择 | localStorage `st_miniapp_chat_bg_v1:<userScope>` | `{ global: Ref\|null, chars: Record<characterId, Ref\|{img:'none'}> }`，`Ref = {img:'cover'\|imageId, night:number\|null, day:number\|null}`；`null` 采光＝自动 |
| 背景图片 | IndexedDB `st-chat-appearance` / `images`        | `{id, ownerId, blob, hi, lo, createdAt}`，每人最多 12 张，满了不再显示「＋」，删掉一张再加；不做静默淘汰                                                        |

- 一个 zustand store `stores/appearance-store.ts` 管昼夜和字号；背景用 `lib/appearance/chat-background.ts`（纯函数 + 存取）和 hook `useChatBackground(characterId)`。
- 生效规则：`chars[id] ?? global ?? 无`。`{img:'none'}` 只在"全局有图、这张卡不要"时写入。
- `chars` 上限 200 条，超出删最久未用的；读取时校验形状，非法内容按没设过处理。
- 拒绝：存服务端（要建表、审核、存储成本，且首帧拿不到）；放进 `UserSettings`（不是生成偏好）。

## 2. 昼夜

- `layout.tsx`：`<html className="dark" suppressHydrationWarning>`，`<head>` 内一段内联脚本：读到 `day` 就移除 `dark`。在首帧绘制前执行，不闪。
- `globals.css`：`:root` 换成白天色板（值见原型 `phone.css`，已算对比度：正文 13.8:1、次要 5.8:1、主色 6.0:1、对白 5.5:1），`.dark` 不动；两处各加 `color-scheme`。
- 写死颜色：659 处里剧场 201、短剧问卷 28、增长弹窗 52 保持深色不动；其余 378 处按三类处理：
  1. 页面底色和卡片底（`#19171a`、`#252227`、`#222024` 等）→ 新增三个 token `page` / `surface` / `surface-2`，夜间值与现有 hex 完全相同；
  2. `white/[0.0x]` 叠层与描边 → 新增 `veil` token（夜间白、白天梅紫），透明度沿用；
  3. 专用文字色 → 归到 `foreground` / `muted-foreground` / `mauve` / `primary`，夜间色值不同的保留原值作为该 token 的夜间值，不合并近似色。
- 保持深色的区域包一层 `.dark`：`/dramas`、`/watch`（含该路由下的底栏）、封面上的角标、VIP 卡、开屏。`.dark` 在子树重新声明 token，不需要改内部组件。
- `ReplyRenderer` 的 `theme` 由写死 `dark` 改为读 store；线上富回复规则 237 处颜色都是 `light-dark()`，直接生效。
- Telegram 顶栏/背景/底栏：仅当用户点过切换（存储里有值）才调用 `miniApp.setHeaderColor` / `setBackgroundColor` / `setBottomBarColor`，逐个判断 `isAvailable`；没点过的人完全不变。
- 图标画目标态（夜间显示太阳），`aria-label` 为「切换到白天/夜间」。

## 3. 聊天背景

- 图层：聊天根节点 `relative isolate`，背景 `fixed inset-x-0 top-0 h-[100lvh] -z-10`。不跟随 visualViewport 缩，键盘弹起时不缩不跳。有背景时根节点底色透明，顶栏和输入区改半透明底并去掉 `backdrop-blur`（弱机约束）。
- 图片 `<img object-cover object-[50%_30%] decoding="async">`，本机图用 object URL（换图、卸载时 revoke）；封面用现有 `lobbyImageUrl`。页面就绪（`useEntryEnrichReady`）后才读取和挂载，淡入 150ms。
- 导入：`createImageBitmap`/`<img>` 解码 → canvas 缩到宽 ≤1080、高 ≤2340 → WebP（不支持则 JPEG）质量 0.82 → 入库。原图 >20MB 或解不开直接报一句。
- 亮度统计：24×48 取样，存 92 分位 `hi`、8 分位 `lo`。封面跨域用 `crossOrigin="anonymous"`，取不到时按 `hi=.9, lo=.1` 保守处理。
- 采光 → 遮罩不透明度 `0.96 - 0.86·L/100`，遮罩色 = 当前 `--background`。
- 字底：按当前遮罩下图片最碍眼的亮度，取让正文和对白都 ≥4.5:1 的最小不透明度，加在整条 AI 消息（含名字和工具行）上；不碍事就是 0。
- 自动起点：字底 ≤0.3 时的最大采光，范围 15–70。
- 面板改范围：全部对话→仅此角色时，若本次打开面板期间改过全局，则还原打开时的全局值。

## 4. 界面设置面板

- `chat-tools-panel.tsx` 加第三个标签 `look`，内容新组件 `chat-look-settings.tsx`。该标签下 `SheetContent` 的 `overlayClassName` 设为透明、无模糊（已有此入参）。
- 拖滑杆：`pointerdown` 给面板加状态类，其余内容淡出、底色透明，只留正在拖的一条；`pointerup/cancel` 还原。滑动过程直接写 CSS 变量，松手再落存储，不逐帧触发 React 重渲染。
- 收起：复用 `usePullDownToClose`（内容到顶后下拉）、`useTelegramBackButton(close, 'dialog')`、点外面、Esc。
- 滑杆用原生 `range`，`touch-action: none`，热区 44px。

## 5. 字号

- 五档 14 / 16 / 18 / 20 / 23px（倍数 0.875 / 1 / 1.125 / 1.25 / 1.4375），默认第 2 档，即线上现有大小。
- 线上正文规则是运营 CSS 里的 `font-size: 16px`，选项卡是 11–15px，Tailwind 改不到，所以在回复正文容器上用 CSS `zoom: var(--reply-scale)` 整体缩放；不去改写运营 CSS（那条路径有安全校验，正则改写风险更大）。
- 小档下选项按钮和折叠标题的 44px 热区由 `globals.css` 按 `44px / 倍数` 补足，不改 `reply-renderer`（它的测试锁定了内联 44px）。
- 用户气泡、编辑框、输入框用 `calc(Npx * var(--reply-scale))`，输入框封顶 1.25 倍。
- 改档前记下视口内第一段的位置，`useLayoutEffect` 里还原；本来贴底的沿用现有 `useStickToBottomResize`。
- 大字号不收窄两侧留白：右侧状态标签占 36px，收窄会压字。

## 6. 失败与恢复

- localStorage/IndexedDB 读写全部 try/catch：读不到按默认，写不进本次仍生效。图片读取失败按「无」显示并保留选择，下次再试；连续失败不重试。
- 并发：多开窗口以最后写入为准，不做同步。
- 回滚：纯前端，回滚发布即可；残留的本地数据无副作用。白天色板出问题的止损是把切换图标隐藏，首帧脚本忽略存储值。

## 7. 观测

客户端 `sendSentryLog`：`appearance.theme_changed`、`appearance.background_applied`、`appearance.background_import_failed`。只带有限枚举和大小分桶，不带图片、文件名、角色 ID。
