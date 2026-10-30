# 规划评审

2026-10-29：用户已确认任意轮次分支、初始取 min(A, available)、后续 A/B 窗口、记忆位于正文。独立 SQL 评审无阻断；纳入三点：幂等恢复先于源软删检查；继承按固定 history ID 引用原表而非 current view；验证硬删/账户级联与引用元数据的兼容。继承末轮重生成写分支自己的真实新行，本地行覆盖固定继承。通过规划门禁，可开始本地实现；无远端变更/发布授权。

产品修正：按 Codex 心智，分支是列表新增的独立对话，自动切换；无额外“返回原对话”入口，原对话原样保留。

## 完整差异独立复审

2026-10-29：branch_backend 对 SQL/前端/服务端完整差异静态复审，发现新 RPC 直接锁 app_core.users 不符合现行跨域约束；已改为带 conversation-branch 命名空间的事务 advisory user lock，来源会话 ownership 与 FK 保持。修改后无 blocker。固定 revision 引用、选择轮次上限、嵌套展开、分支末轮重生成、A/B 窗口、缓存/草稿/分页隔离、丢响应复用请求号均核对。SQL 最终并发结果见 database-verification.md；其余检查见 verification.md。

当前只完成本地开发，未暂存/提交/推送；未执行远端迁移或上线。未来提交评审范围是本任务模块文档与 module-updates、README/ARCHITECTURE、shared conversation 契约与新增迁移/隔离SQL、backend conversation repositories/route/errors及定向测试、frontend chat组件/hook/API及既有测试、ui-tests既有fixtures/chat场景。最终路径清单可由 git diff --name-only 与未跟踪路径列表互证。
