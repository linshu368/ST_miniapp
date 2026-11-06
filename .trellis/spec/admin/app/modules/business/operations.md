---
module_id: admin.business.operations
title: 配置、内容与增长运营
scope: admin
category: business
status: active
owners: [admin]
last_verified_task: .trellis/tasks/11-02-lobby-quality-rotation/
last_verified_at: 2026-11-02
---

# 配置、内容与增长运营

## 职责与边界

管理模型/运行配置、角色卡、公告和邀请规则；生产操作也可通过 `pnpm admin` CLI 完成。

## 当前状态

主要运营页面已集中在 Admin SPA。图片运营只管理普通图片配置；`image_advanced_*` 与独立 VIP 媒体配置页已删除。VIP 策略仍管理 `feature_free_trial_limits.basic_image`，普通图片免费次数不受影响。

## 入口与调用者

内部运营人员通过 Admin 导航使用。

## 涉及文件

| 路径                                                   | 职责     |
| ------------------------------------------------------ | -------- |
| `packages/admin/src/components/ModelCatalogEditor.tsx` | 模型配置 |
| `packages/admin/src/components/CharacterCardsView.tsx` | 角色卡   |
| `packages/admin/src/components/AnnouncementsView.tsx`  | 公告     |
| `packages/admin/src/components/InviteProgramView.tsx`  | 邀请计划 |

## 关键实现链路

登录/环境 → 表单校验 → Admin API/Supabase → 发布或原子写 → 审计结果。

## 数据、契约与外部依赖

依赖 Backend、Supabase session、runtime_config 和 shared 契约。

## 关键节点与约束

发布、赠送、上下架等写操作必须确认、防重复并展示结果。

## 验证方式

Admin test/typecheck/build 与 test 环境人工 smoke。

## 已知缺口与待核验项

生产配置变更需独立人工确认和观察。

## 关联模块

`admin.infrastructure.admin-client-auth`、`backend.infrastructure.runtime-data-security`。

## 图片创作广场 V2（2026-10-12）

Admin 在现有配置草稿、发布、回滚链路中增加图片广场模型目录、首次分享提示与标签管理；模型页包含上架星尘价计算器，但最终发布值仍是服务端权威 credits。配置 schema 同时在 shared 和数据库发布校验器中约束。（2026-11-03 起分享自动打标开关已撤，恒开启。）

## 兜底配置与竞争交付（2026-10-28）

`FallbackConfigEditor` 继续使用模型目录的草稿→保存→发布链路。每型号 `first_token_timeout_ms` 默认4000ms，表示从首发实际派发到启动兜底的阈值；触发后首发继续竞争。顶层 `fallback_timeout_ms` 保留字段名与2000ms默认值，展示为“兜底预留时间”，仅用于前置过慢时在总截止前提前启动兜底，不限制兜底自身时长。两项都须为正整数且小于总等待上限，不将两项相加当作顺序阶段预算。

所有尝试共享 `first_token_deadline_ms`，默认10000ms；先出有效首字的一方负责回复，另一方立即停止。同型号静默等待不重复请求，明确失败最多顺序重试一次。兜底型号仍可运营选择，报价/权益沿用户所选型号，只结算一次。超时率目标默认1%，仅供人工监控；AI自动调参未启用。

编辑器说明、可访问名称、校验报错与发布差异摘要必须使用同一语义。保留“先保存草稿，再发布当前草稿”；本次只改变执行语义和文案，数值未变，无需操作生产配置发布。Admin/shared既有schema与差异测试核对保存兼容和发布说明，实际部署状态以任务发布记录为准。

## 变更记录

- 2026-10-16：标准价改为目录顶层可选 standard_prices 元数据，随草稿保存并回填，公开模型与实际扣费仍仅使用原模型字段/credits；统一参数仍为页面临时值。旧目录无标准价时留空，不反推。

- 2026-10-16：标签编辑采用独立 UI 行标识并保留空值/重复 ID 中间态，保存仍使用 shared 严格校验。模型定价增加本次页面有效的标准价、统一参数、公式预览和批量重算；缺失任一档位标准价时不部分覆盖，只更新 credits 草稿，不持久化计算参数。

- 2026-10-15：任务 `10-15-image-plaza-tag-prompt-filter` 将标签功能开关文案改为仅控制分享自动打标。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## 2026-10-23 可运营回复风格

平台规则菜单包含“主体与模块规则”和独立“回复风格”。reply_style_options为受控JSON目录，复用草稿/发布/历史/回滚、权限/环境；选项可增删改排序/启停，英文marker/rules运营自填可空，手机预览独立多开。编辑中空行保留，保存严格校验；脏离开确认、保存禁编辑/重复写，未保存不能误发布旧草稿。

## 前几屏优质轮换（2026-11-02，本地未发布）

现有LobbyRankingParamsEditor顶部提供前几屏轮换参数：默认24h、重复2、探索最多2。轮换发布后全量生效，运营端无启用开关或灰度比例控件；旧enabled/rollout仅为存量配置兼容，不控制实际生效。原评分参数仍控制离线质量计算；resolveLobbyRankingEditorValue兼容嵌套rotation。LobbyPinnedCharactersEditor将原8项作为加权候选、独立最多1固定主推；沿用参数草稿/发布/回滚，无需运营另行激活推荐。

## 运营平台 CLI 与菜单归类（2026-11-03）

- 新增 `packages/admin-cli`（`pnpm admin`，只连生产）与 `packages/admin-client`（网页与 CLI 共用的注册表、菜单分组、RPC/HTTP 调用）。CLI 以本人运营账号登录、经同一后端代理调用同一 RPC，写操作必须确认（`--yes`），草稿共用且默认不覆盖他人未发布草稿。
- 侧栏按 `ADMIN_MENU_GROUPS` 分 7 组：模型与计费、对话与回复、角色与大厅、充值与会员、用户增长、图片，末尾发布历史；CLI `config list` 使用同一分组。
- 删除入口：系统兜底角色、每日签到奖励（遗留）、媒体免费轮次次数、分享自动打标开关（后端恒开启）、推荐主推候选（后端停用固定位/主推）、回访星尘赠送页面。数据库配置行、校验函数与 `grant_user_credits` 等 RPC 保留未删。
- 任务：`.trellis/tasks/11-03-admin-cli/`。

## VIP 混合星尘奖励（2026-11-05）

VIP 策略分别编辑每日签到专项/通用星尘及月卡开通专项/通用赠礼。仍用原两项 managed config、草稿→差异→发布；admin-client 共用 schema，CLI 无需新命令。旧数字签到配置可读，周卡赠送约束仍为零。

隔离 PG 覆盖并发、幂等、旧订单及故障回滚；远端执行与部署状态见任务 `11-05-vip-mixed-rewards` 的发布记录。
