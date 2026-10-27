# 发布审核与验证

用户要求补齐首发未出字明确失败立即兜底，承接“测试通过直接上线、先合dev、生产只聊天修复”授权，无需再确认。

变更：只修改首字编排生产文件 first-token-fallback.ts；扩展现有 first-token-fallback/execute 测试及 backend 规范、模块知识和本任务文档。无数据库/公开契约/前端/环境配置改动。

验证：Backend 全量 953 测试；shared 179；Backend typecheck；imports；diff-check；21模块 baseline。真实本机 HTTP/SSE：503、错误帧不关连接、空DONE不关连接，收到失败后约13/3/1ms派发兜底并交付；数字为本地受控测试，不代表真实供应商耗时。

覆盖：401/403/429/503、无body、连接/读异常、空EOF/DONE、JSON/文本error事件、choice error/refusal/finish、拆帧、同型号仅重试一次、原首发timer清理、取消/截止不重试、已有正文/公开思考不切、双失败免扣、两供应商付费/免费报价权益一次。首发错误/终态观测沿用原attempt，不新增统计。

发布：fix/immediate-pretoken-fallback → dev；CI + TEST健康与正常SSE；从最新main精确带入工作提交（不含短剧），CI通过管理员合并 → Railway生产；核对SHA/health。外部审查如仍HTTP402按此前授权处理，不改保护。回滚仅后端代码，无迁移或追账。
