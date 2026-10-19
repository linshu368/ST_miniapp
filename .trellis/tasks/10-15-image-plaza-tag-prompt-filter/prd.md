# 图片广场标签展示与自动打标解耦

## Goal

标签展示与分享自动打标解耦；点击标签按提示词中文译文筛选。

## Requirements

- `image_plaza_tags_feature_enabled` 只控制分享自动打标，保留配置键及缺失时开启的默认值。
- 默认展示目录中启用的标签并保留排序；无目录时不伪造业务标签。
- 按标签中文 label 在 `snapshot.prompt_zh` 中字面包含匹配，不做同义词扩展，不按作品 tags 数组匹配。
- 服务端先筛选再分页；标签与搜索框条件取交集。
- 点击「全部」（`tag=all` 或不传业务 tag）不做标签限制，按现有排序与分页返回全部公开作品；若同时有搜索词，仍只按搜索过滤。
- 无中文译文不命中业务标签筛选；未知或禁用标签仍拒绝。
- 不操作远程库、不补译、不改变分享返利、显式标签及幂等。

## Acceptance Criteria

- [x] 开关 true/false 时 feed/config 返回相同启用标签，关闭仍可筛选。
- [x] 点击「全部」不受标签约束、直接展示全部数据（可与搜索叠加）；业务标签的中文匹配、无译文、空态、组合搜索与分页符合上述规则（repository mock + route 逻辑；真实 DB/UI 待人工）。
- [x] 特殊字符不扩大查询（mock 锁定转义）；非法标签 400；DB 失败沿用既有路径。
- [x] 分享关闭不调用打标模型，既有分享回归通过。
- [x] 管理端文案说明只控制自动打标。
- [x] 扩展 config 测试；新增 `repository.list-works.test.ts` mock 回归。
- [x] Backend image-plaza tests 29 passed、backend typecheck 通过；shared/admin/frontend test/typecheck/build 因本机缺 vitest/parse5/@miniapp/reply-renderer 未能跑通（与本改动无关）；未做真实库与 Telegram UI 人工验证。

## Notes

- 实现已完成；真实 JSONB ILIKE 性能与「有译文但 tags 为空」等场景需在 TEST 环境人工确认。
