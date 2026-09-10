# Preset Platform 测试素材 UI 实施计划

## 顺序

1. 读取父任务设计、参考 HTML、SPA shell、materials backend 契约和 UI/state spec。
2. 实现测试素材页布局：当前环境角色卡搜索/分页/选择区 + 脱敏输入样本区。
3. 接入环境化 Query keys，环境切换清理角色卡和样本缓存。
4. 实现“用于当前会话”和“使用输入样本”动作，保证只影响当前私有会话输入状态。
5. 覆盖空态、错误态、权限、超时、下架角色和脱敏服务失败。
6. 更新 preset-platform features/UI/state/testing spec。

## 验证

```bash
pnpm --filter @miniapp/preset-platform typecheck
pnpm --filter @miniapp/preset-platform test
pnpm --filter @miniapp/preset-platform build
```
