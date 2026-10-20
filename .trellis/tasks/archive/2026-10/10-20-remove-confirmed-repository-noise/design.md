# 技术设计

## 边界

本任务只做删除与事实同步，不改变仍在运行的业务逻辑。删除对象必须满足以下至少一类证据：无静态或框架入口、唯一消费者同时删除、对应产品/包已经退场，或用户已明确接受删除其完整功能链。

## 删除链路

### 许愿池

按完整调用链删除：

`/create/wish 页面 → frontend wishes hooks → shared wishes DTO → backend wishes route → MiniappWishRoleRepository`

同时删除 `app.ts` 注册、Shared 根出口、底栏隐藏路由、Prisma 应用层映射和现行架构/spec 清单。历史 migration 和现存数据库表保留，避免把代码清理扩展为不可逆数据删除。

### Upstash 配置缓存

`UpstashConfigStore` 当前没有 import 或实例消费者，运行时配置实际走 `platform/runtime-config.ts`。删除文件后同步删除 Railway/env 模板中的两个变量和 README/ARCHITECTURE/spec 的缓存描述，避免保留虚假能力。

### Frontend 脚手架

删除零消费者的 UI、API、Mock registry、时间工具、样例表单和死动画；同步移除只被这些文件使用的依赖、Mock 环境变量及 RHF/Zod 的现状声明。以后出现真实表单时再按规范按需引入，不保留预装代码。

## GHCR 判定

删除前同时满足：

1. 仓库源码、workflow、部署配置中没有 `ghcr.io` 镜像消费方；
2. Railway/Vercel/Docker 现行路径均从源码构建；
3. 可见的 GitHub Actions、分支/tag 和 package 使用信息没有活跃消费者证据。

若第三项无法确认，则保留 workflow 并在任务记录中标为未删除。

## 兼容与恢复

- 旧 `/create/wish` 和 `/api/wishes*` 将返回 404，这是用户明确授权的退场结果。
- 删除静态角色图后，旧的相对图片 URL 将失效；用户已明确要求删除，恢复方式为 Git revert。
- 所有删除均可从 Git 历史恢复，不建立 deprecated shim。
- 不执行数据库清理，避免不可逆数据风险。

## 测试策略

不新增测试。通过残余引用扫描、受影响包 typecheck/test、全仓 typecheck、lint、legacy guard、Frontend/Admin build 验证删除闭合性；部署 workflow 以 YAML 和引用扫描核验。
