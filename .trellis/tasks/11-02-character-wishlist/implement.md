# Execution

1. shared定义心愿/请求/响应和通知契约。
2. 后端功能域迁移与事务RPC、权限路由、现有发布可选关联。
3. 前端wall/detail、创作关联与入口、消息按钮。
4. 扩展既有UI fixtures和creator测试；补安全/迁移回归（新业务权限和幂等风险必须锁定）。
5. pnpm -r typecheck，相关vitest，pnpm --filter frontend build，本地数据库脚本，pnpm test:ui --grep @wishes。人工手机宽度查看所有入口与空态错误。

失败场景：拒绝私密创建；撤回不可被他人读取和关联，非作者不能提交卡；重试不重复计数/通知；发布成功关联失败可以补关联；切换账号query按身份隔离；作品失去公开资格不展示。
