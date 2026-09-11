# CS Platform 测试、构建与部署

## 当前门禁

```bash
pnpm --filter @miniapp/cs-platform typecheck
pnpm --filter @miniapp/cs-platform build
```

当前没有 test script，CI 覆盖也需以实际 workflow 为准，不得写成已自动测试。

## 测试必要性与验证要求

- 默认不自动新建测试文件或引入 Vitest。只有用户明确要求、审核后的验收标准确认需要，或上述高风险逻辑经评估必须回归锁定时，才添加最小测试基础设施。
- 无论是否新建测试，组件/交互至少人工覆盖登录失败、空态、轮询错误、重复提交、部分群发失败、切换环境清理。
- bug 修复先评估并确认是否需要回归测试文件；未确认时不自动创建，并在 task 写清既有验证、人工步骤、期望、缺口与剩余风险。

## Vercel

- 包内 `vercel.json` 是静态 SPA 配置；核对 Root Directory、build/output、rewrite 和 Node 版本。
- Preview 必须使用独立 token/API，禁止默认执行生产群发或回复。
- 发布后 smoke test 登录、画像/用户列表、消息读取、测试用户发送、客服环境切换和错误恢复；回滚到上一成功静态部署。
