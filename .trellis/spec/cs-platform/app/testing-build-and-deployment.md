# CS Platform 测试、构建与部署

## 当前门禁

```bash
pnpm --filter @miniapp/cs-platform typecheck
pnpm --filter @miniapp/cs-platform build
```

当前没有 test script，CI 覆盖也需以实际 workflow 为准，不得写成已自动测试。

## 新增测试要求

- 为 API envelope/error、query key、环境隔离、状态转换和群发结果汇总补 Vitest。
- 组件/交互至少覆盖登录失败、空态、轮询错误、重复提交、部分群发失败、切换环境清理。
- bug 修复先补回归；无法自动化时在 task 写清人工步骤、期望和缺口。

## Vercel

- 包内 `vercel.json` 是静态 SPA 配置；核对 Root Directory、build/output、rewrite 和 Node 版本。
- Preview 必须使用独立 token/API，禁止默认执行生产群发或回复。
- 发布后 smoke test 登录、画像/用户列表、消息读取、测试用户发送、客服环境切换和错误恢复；回滚到上一成功静态部署。
