# Preset Platform 预设管理 UI 实施计划

## 顺序

1. 读取父任务预设管理设计和 Admin 发布/回滚/草稿交互参考。
2. 实现“预设管理”页面，Tab 包含平台预设、预设库、草稿箱。
3. 实现平台默认预设发布/回滚/生产二次确认/expected revision/审计结果展示。
4. 实现已发布预设查看/应用，以及当前操作者私有草稿创建/编辑/重命名/覆盖/另存/应用。
5. 在对话测试页实现右侧预设抽屉，合并已发布预设和我的草稿，快速应用到当前会话。
6. 补冲突、空名、重名、权限不足和应用范围测试。
7. 更新 preset-platform features/UI spec。

## 验证

```bash
pnpm --filter @miniapp/preset-platform typecheck
pnpm --filter @miniapp/preset-platform test
pnpm --filter @miniapp/preset-platform build
```
