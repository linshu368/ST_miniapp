# 安全、RLS 与授权

- 暴露到 PostgREST 的表/view 必须显式评估 RLS；启用 RLS 不等于已有有效 policy。
- policy 以最小权限区分 SELECT/INSERT/UPDATE/DELETE，测试匿名、登录用户、运营和 service role 的允许/拒绝路径。
- grant 与 policy 同时审查；不得用宽泛 schema/table grant 绕开设计。`service_role` 只在服务端 secret 环境使用。
- `SECURITY DEFINER` 函数必须固定安全 `search_path`、schema-qualify 对象、校验调用者/参数、撤销 PUBLIC execute 并显式 grant。
- RPC 必须限制可写字段、幂等/并发语义和错误泄露；禁止返回 SQL、内部 token 或无边界行集。
- 敏感列最小化暴露；日志和文档只记录结构/计数，不记录业务行或个人信息。
- 跨 schema FK/function/view 会扩大权限与发布耦合，设计必须列出依赖和回滚顺序。
