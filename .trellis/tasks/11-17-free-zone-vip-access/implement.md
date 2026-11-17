# Implement：畅聊按身份开放

## 步骤

1. **shared**（`packages/shared/src/api/free-zone.ts`、`growth-prompts.ts`）
   - `FreeZoneAccessSchema` 并入 `FreeZoneConfigSchema.access`（默认关）。
   - `PublicFreeZone` 加 `access`、新状态 `vip_waiting`、`vip_only`。
   - `VipGrowthPrompt` 加 `context`、`bonus_main_credits`、`welcome_days`、`vip_day`。
2. **backend**
   - 新 `features/free-zone/access.ts`：北京时间窗口计算 + `evaluateFreeZoneAccess`（纯函数）+ 单测。
   - `access-facts.ts`：读 `users.created_at`、最近 `vip_purchase_grants.granted_at`（失败抛出，由调用方降级）。
   - `zone-view.ts` / `selection.ts`：入参加 `access` 结果；`resolveCatalogFreeZone`、`resolveFreeZoneSelection` 透传事实。
   - `generation/resolve-model.ts`：选中免费模型且开关开时读事实（失败放行 + warn）。
   - `routes/models.ts`：读事实（`dbUser.created_at` 已有，只补最近开通）。
   - `growth/prompt-rules.ts` + `routes/growth-prompts.ts`：VIP 资格与 context、新频次；去掉 50 轮与"付费 1 次"。
3. **admin**：`freeZoneForm.ts` + `FreeZoneConfigEditor.tsx` 加"按身份开放"一节（开关、试用起始时间、试用小时、开通礼天数、周几/开始时间/时长、弹窗间隔/每批次数/冷却）；表单单测。
4. **frontend**
   - `lib/free-zone.ts`：新状态文字、提示、边界时间；身份文案生成；分隔线推导函数 + 单测。
   - `chat-free-zone-section.tsx`：五种身份外观（对比稿第二排）；非会员开通按钮 → `/vip?returnTo=`。
   - `chat-model-switcher.tsx` / `chat-top-bar.tsx`：新状态兼容；边界刷新时失效弹窗资格。
   - `chat-message-list.tsx`：分隔线（对比稿 ToastB）。
   - `growth-prompt-card.tsx`：VIP 并排双券（对比稿 A，三种 context）。
   - 订单完成页：VIP 订单完成后自动选回畅聊模型。
   - VIP 页：权益里加"免费畅聊"一行（数值取目录 access；拿不到就不显示）。
5. **文档**：`docs/ARCHITECTURE.md` 畅聊一节补"按身份开放"；必要时 spec。

## 验证命令

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test -- free-zone growth
pnpm --filter @miniapp/admin test -- freeZoneForm
pnpm --filter @miniapp/frontend test -- free-zone
pnpm -r typecheck
pnpm lint
pnpm -r build
```

## 失败路径与人工场景（TEST 环境，access 打开）

| 场景                                  | 期望                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 开关关                                | 与生产现状一致：福利期内开放，期外栏目不显示                                                                                     |
| 新注册用户                            | 栏目"新人体验 · 剩 3 天"；把 `trial_hours` 调到 1 后过点：发消息正常回复且扣 15 星尘，分隔线出现，完成这一轮后弹 VIP（新人场景） |
| 非会员老用户，把周几/时间调到当前     | 栏目"VIP 专享"折叠，卡内开通按钮；打开小程序弹"今天是 VIP 畅聊日"；3 天内不再弹                                                  |
| 会员 + 刚开通                         | "开通礼 · 剩 5 天"；把 `vip_welcome_days` 调 0 → 未开放，"周四 12:00 开始"                                                       |
| 会员周四窗口结束                      | 选着免费模型发消息 → 切轻量、分隔线带"下次畅聊：周四 12:00"；不弹窗                                                              |
| 开通 VIP 支付成功                     | 回到对话已选中畅聊模型                                                                                                           |
| 读事实失败（断开/人为抛错，单测覆盖） | 生成不报错，按开放处理，warn 日志                                                                                                |
| 两台设备同时触发 shown                | 只记一次（函数原子判定，单测 + 现有迁移测试覆盖）                                                                                |
| 运营平台改 access 保存再读            | 字段完整、非法时间/范围被拦                                                                                                      |

## 发布

见 design §6；生产配置变更走 `pnpm -s admin config draft set … --json`，差异给用户确认后 `--yes` 发布，再 `get` 复核。
