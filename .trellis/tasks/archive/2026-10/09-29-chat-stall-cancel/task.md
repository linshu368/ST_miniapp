# 任务分解

- T1 completed：基于 origin/main `aa5f241a` 创建 `codex/hotfix-chat-stall-cancel`，完成复用与可靠性规划。
- T2 completed：backend/shared 真实取消、计费前终态竞争、免费预留释放、异常与过期恢复、请求 UUID 绑定及回归。
- T3 completed：frontend 有界等待、取消确认、迟到事件隔离、原消息下重新生成、多设备身份隔离。
- T4 completed：只读审查、全量单测、全包 typecheck、lint、文档与模块知识校验；构建结果见 verification.md。
- T5 pending：TEST/Preview 真实链路与 Telegram 人工验收；未获部署授权，不执行。无 commit/push。
- T6 completed：修复深度思考静默期被 4/6 秒快速首字策略误取消；保留 SLA 事实、绝对期限、显式取消和计费闸门，并补 Backend/Frontend 回归。
- T7 completed：前后端统一移除普通模式 6 秒首字硬终止，保留 4 秒 fallback、6 秒指标、独立准备超时与 110/120/150 秒生命周期，并扩展现有回归。
