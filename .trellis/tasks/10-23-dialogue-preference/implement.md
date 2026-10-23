# Implementation

1. 撤回仅本分支未发布的静态对白key/字段/engine注入，保留thinking恢复和通用UI原型；Shared定义generic配置、metadata、boolmap契约先行。
2. 并行实现backend展示API/repo原子mapmerge（无prompt注入）、Admin独立导航受控editor+managedconfig、frontend动态舒适布局和逐id缓存。
3. 单份migration与Prisma；只在隔离localPG验证schema/validator/ACL/并发/幂等/旧配置保留，TEST/production workflow门禁独立。
4. Sharedtests+alltypes，相关全backend/frontend/admin测试和build，静态lint/import/migration检查；原thinking回归保留通过。
5. 浏览器验证真实手机布局、AdminCRUD/独立多开/排序/失败反馈/空态/环境与保存禁用；规则隐私检查。
6. 仅本任务与thinking修复进入reviewablePR，前置门禁通过后按用户授权发布到st-admin-platform.vercel.app及对应正式前后端；不得操作其它dev，权限阻断说明具体原因。
