# 数据库重组阶段 3：用户与状态拆分

## Goal

`app_core.users` 只留身份；归因、累计轮数、TG/自定义资料、一次性标记、偏好、角色上架状态各回各的表，以后加字段有明确落点。运营配置校验链（15 层包装）重写为单函数。

## Requirements

1. 3a：归因列 → `miniapp_traffic.user_attributions`；`total_round`（users 与 settings 两份）合并为 `experience.user_chat_stats`；建号走 `app_core.ensure_user`，登录/机器人入口走 `miniapp_traffic.enter_user`；删除无人使用的分析视图。
2. 3b：settings 拆分：资料 → users；一次性标记 → `miniapp_features.user_marks`（并入 growth_prompt_states）；首次分享资格由返利记录推导；剩余偏好整表改名 `app_core.user_preferences`。
3. 3c：角色上架列 → `app_core.character_listings`。
4. 3d：`admin.validate_managed_config_value` 重写。

## Acceptance Criteria

- [ ] 每步本地 PG17 非超级用户脚本通过（含视图迁移前后逐行一致）→ TEST → 生产扩展步 → 后端发布 → 核对旧列不再被写 → 收缩步删列。
- [ ] 客服仓库读的 `cs_feed` 视图输出列与类型不变。
- [ ] registry 回写。

## Android/iOS 性能 P95 门禁

见 `task.json.meta.mobile_performance`。
