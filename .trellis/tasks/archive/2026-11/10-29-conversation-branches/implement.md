# 执行与验证

1. 评审方案和接口，记录关键问题，按最终方案实现。
2. Shared先定义 branch DTO/schema，后端repo/route接入；SQL在唯一migrations目录，隔离PG17验证。修改既有基础开轮RPC时保持原行为。
3. 前端复用footer/selectSession/cache/draft，移动端图标触区与切换反馈。
4. 扩展ui-tests fixtures/data.ts、server.ts、chat.spec.ts，200轮虚构数据；最近50、早期20、retry重复、continue、return、narrow。
5. 运行backend相关tests/shared tests/alltypecheck/前端相关tests及build；SQL隔离回归和@chat-branch。针对新失败修复，不无故全量重复。
6. 更新相关模块/spec与本地验收说明；记录未做真实数据库迁移/供应商调用/生产发布。展示本地预览与截图。

命令：pnpm --filter @miniapp/shared test；pnpm --filter @miniapp/backend test -- ...；pnpm -r typecheck；pnpm --filter @miniapp/frontend build；pnpm test:ui --grep @chat-branch；bash scripts/test-conversation-branches-migration.sh。
