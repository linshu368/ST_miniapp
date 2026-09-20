# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                       | Files / Scope                       | Depends On | Verification                         |
| --- | ------ | ------------------------------------------ | ----------------------------------- | ---------- | ------------------------------------ |
| T1  | Todo   | 实现大厅返回快照 helper 与严格降级         | Frontend lobby helper               | -          | typecheck + 存储异常人工验证         |
| T2  | Todo   | 捕获列表条件、已加载顺序与角色锚点         | CharacterGallery / CharacterCard    | T1         | 深列表进入前快照检查                 |
| T3  | Todo   | 恢复初始条件、缓存数据和锚点位置           | CharacterGallery / characters query | T1,T2      | 推荐/最新/搜索/弱网矩阵              |
| T4  | Todo   | 统一聊天顶部、Telegram 与 history 返回语义 | chat page / ChatTopBar / helper     | T1         | 三类返回路径真机验证                 |
| T5  | Todo   | 验证分页兼容、局部更新与失败降级           | Frontend 全范围                     | T2,T3,T4   | 人工矩阵 + 现有 test/lint/build      |
| T6  | Todo   | 更新模块事实并完成最终检查                 | frontend module spec                | T5         | module knowledge check + diff review |

## 执行约束

- 当前仅完成规划，所有任务保持 Todo；审核通过且 `task.py start` 后才能写产品代码。
- T3 不得复制完整服务器列表到新的客户端 store；T4 不得破坏充值/自定义语音的聊天内回跳。
- 若实施时发现大厅已被上游改成分页，先重新核对 query/pageParams 结构并更新 design/implement，不直接改写上游行为。
