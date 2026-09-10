# Preset Platform 测试素材与脱敏实施计划

## 顺序

1. 读取 backend/data/database 安全规范，确认当前环境角色卡与 experience 历史访问边界。
2. 实现当前环境角色卡摘要与按 ID 取生成上下文，只读访问，不回写角色卡。
3. 实现真实用户输入有界查询：角色范围、时间窗、分页、最小长度、必要列。
4. 实现关键用户信息脱敏和 opaque sample id；首期不做内容审计。
5. 补 PII fixture、权限负测、下架/无样本/超时测试和零写入证明。
6. 检查 response/log/Sentry 不含原文、身份或联系方式。
7. 更新 backend/database 安全 spec 和任务风险记录。

## 验证

```bash
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
```
