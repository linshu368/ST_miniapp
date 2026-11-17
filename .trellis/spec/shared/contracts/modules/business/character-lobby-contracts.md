---
module_id: shared.business.character-lobby-contracts
title: 角色、大厅与收藏契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/11-04-lobby-fast-entry/
last_verified_at: 2026-11-04
---

# 角色、大厅与收藏契约

## 职责与边界

定义角色卡展示、收藏、置顶、精选和排序参数的跨包形状。

## 当前状态

Backend、Frontend 与 Admin 共同消费。

## 入口与调用者

由 shared 根出口导出。

## 涉及文件

| 路径                                              | 职责     |
| ------------------------------------------------- | -------- |
| `packages/shared/src/api/characters.ts`           | 角色 DTO |
| `packages/shared/src/api/favorites.ts`            | 收藏 DTO |
| `packages/shared/src/api/lobby-ranking-params.ts` | 排序参数 |

## 关键实现链路

Zod/DTO → Backend route → Frontend/Admin consumer。

## 数据、契约与外部依赖

无 I/O，不导出数据库行。

## 关键节点与约束

排序枚举和分页字段变更必须兼容现有消费者。

## 验证方式

Shared tests 与所有消费者 typecheck。

## 已知缺口与待核验项

新增展示字段需先确认 browser-safe。

## 关联模块

`backend.business.character-lobby`、`frontend.business.character-lobby`。

## 角色互动契约（2026-10-29，本地待发布）

新增 `src/api/character-social.ts` 并从shared导出：CharacterSocial、CharacterComment、批量/单项social响应、游标评论响应与创建评论/设置点赞/举报schemas。公开评论只含匿名author、is_mine、正文和时间，不公开用户ID。点赞采用目标布尔状态；评论由客户端提交UUID与1–500字纯文本；举报reason为inappropriate/spam/other。原角色与收藏契约不改动。

## 前几屏优质轮换（2026-11-02，本地未发布）

新增api/lobby-recommendation.ts：24h默认、rotation可选配置、严格open/resume/refresh/undo请求与平铺批次ID/时间/全顺序/头12响应，曝光最多40卡。不传用户ID或数据库行。lobby_ranking_params.rotation缺省使用24小时全量轮换，旧enabled/rollout字段仅兼容历史配置、不再控制启用；lobby_pinned_characters 契约已于 2026-11-03 删除（运营固定位/主推停用）。is_featured为全局精选资格，与个人位置解耦。

## 创作数据契约（2026-11-02）

api/creator-analytics.ts 定义严格query与按section区分的runtime响应。all/7d/30d，page>=1、page_size<=20、可选单卡/as_of；不接受owner字段。金额允许负调整，人数/次数非负整数。总览每类最多3条，其余每页最多20；只含卡摘要/统计/匿名公开反馈，无内部资产ID、用户ID或私聊正文。Backend/Frontend/ui-tests共用，同版本先部署producer。

### 心愿契约（本地候选）

api/character-wishes.ts 定义输入长度、固定public可见性、分页、匿名DTO及明确 supported 布尔 mutation。PublishCreatorCharacterSchema 接受可选 wish_id，SetCreatorVisibilitySchema 保持独立不接受此字段。GetCreatorCharacterData 可携带 wish_response linked/not_linked；客户端不得把not_linked当角色发布失败。通知新增character_wish_response及{wish_id,character_id} metadata，VIP consumer须缩窄旧metadata类型；跳转根据校验UUID构造内部 /wishes/:id，不信任任意action_path。

## 推荐首屏摘要

个人推荐请求的 `include_head_cards` 是可选字段，新客户端可获得 `head_cards`。未选择该字段的客户端可继续使用原顺序协议。搜索和目录读取沿用已有公开契约。
