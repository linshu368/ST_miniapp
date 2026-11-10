# 可执行任务

| ID  | 状态                | 内容                                    | 文件范围                                                                                         | 依赖/验证                                    |
| --- | ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| P1  | done                | 根因/源码/复用及可靠性调研              | research/, prd/design/implement/task                                                             | 审计证据核对                                 |
| P2  | pending_user_review | 用户审核最新规划，随后start             | task.json                                                                                        | 不以原始修复请求代替本次规划审核             |
| F1  | pending             | 兼容查找与引导按需加载                  | onboarding/chat-guide.tsx, chat/chat-message-list.tsx及必要测试                                  | P2；缺findLast回归                           |
| F2  | pending             | 根错误重载与身份捕获/401提示            | global-error.tsx, telegram/auth.ts, hooks/use-chat-session.ts及必要helper                        | P2；合法身份/缺身份/重载/不重复写            |
| F3  | pending             | 目录总截止、慢成功及缓存降级            | api/characters.ts, perf/request-timing.ts, mobile-performance.ts；必要时lobby-recommendations.ts | P2；取消/排队/body/排序                      |
| B1  | pending             | 抽取历史分页与GET编排、只读短恢复及诊断 | ConversationHistoryRepository.ts, 专用读取模块, conversations.ts, 专用GET编排                    | P2；owner在先/最多2次读取/总8秒/失败无空历史 |
| F4  | pending             | 有证据的首屏非关键依赖后移              | providers/PagePerfTracker等必要边界                                                              | F1/F3；构建对比，媒体计时起点不变            |
| V1  | pending             | 扩展现有UI/单元失败恢复回归             | ui-tests既有fixture及chat/roleplay/startup，相关Vitest                                           | F1-F4/B1；消费者typecheck+build+lint         |
| D1  | pending             | 更新模块spec、性能验证与回滚说明        | frontend/backend相关module，必要README/architecture                                              | V1；不宣称已上线                             |
| C1  | pending             | 交付本地diff与检查报告                  | task报告                                                                                         | D1；不自动commit/push/deploy                 |
